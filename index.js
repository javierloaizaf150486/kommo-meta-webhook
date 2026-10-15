const express = require('express');
const crypto = require('crypto');
const { createClient } = require('redis');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PIXEL_ID = process.env.PIXEL_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_SUBDOMAIN = 'loaizafjavier';

// Ventana en la que la MISMA persona (mismo teléfono) cuenta una sola vez por evento,
// aunque Kommo tenga varios leads (p. ej. escribió desde dos campañas).
const PERSON_DEDUPE_DAYS = Number(process.env.PERSON_DEDUPE_DAYS || 7);
// Cuánto tiempo se conservan en Redis los datos del contacto (incluye ctwa_clid y ref del anuncio).
const CONTACT_TTL_DAYS = Number(process.env.CONTACT_TTL_DAYS || 30);

// Conectar Redis
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('Redis error:', err));
redis.connect().then(() => console.log('Redis conectado ✅'));

const stageToEvent = {
  '70153595': 'Lead',
  '70153607': 'Contact',
  '70153599': 'Contact',
  '70153530': 'ViewContent',
  '70153006': 'Schedule',
  '27734908': 'Cancel',
  '80101915': 'Purchase',  // "acudio a cita" (EMBUDO EMI)
  '70153611': 'Schedule',  // "Agenda" (EMBUDO EMI) — el SalesBot mueve aquí al agendar; NO es asistencia
};

// EMBUDO ANGELES (pipeline 14560655). Sus etapas se mapean por embudo porque "ACUDIO CITA"
// es la etapa de ganado de Kommo (status 142), cuyo ID es el mismo en todos los embudos.
const stageToEventByPipeline = {
  '14560655': {
    '112489747': 'Schedule',  // AGENDO
    '142':       'Purchase',  // ACUDIO CITA
  },
};
// Ref. (sin mapear a propósito): 112489363 Incoming leads, 112489367 Contacto inicial,
// 112489371 Validación, 112489375 Información, 143 NO AGENDAR.

const hashData = (value) => {
  if (!value) return null;
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
};

// Meta pide el teléfono solo con dígitos y código de país (sin "+"), antes de hashear.
// Kommo/WhatsApp entrega números como +521667XXXXXXX (formato móvil viejo de México);
// el formato actual es 52667XXXXXXX. Se mandan ambas variantes para no depender de cuál
// tenga guardada Meta; si el número ya viene en un solo formato, se manda solo ese.
function phoneHashes(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return [];
  const variants = new Set();
  let ten = null;
  if (digits.length === 10) ten = digits;
  else if (digits.length === 12 && digits.startsWith('52')) ten = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith('521')) ten = digits.slice(3);
  if (ten) {
    variants.add('52' + ten);
    variants.add('521' + ten);
  } else {
    variants.add(digits); // número extranjero u otro formato: se manda tal cual, solo dígitos
  }
  return [...variants].map((v) => crypto.createHash('sha256').update(v).digest('hex'));
}

async function saveContact(key, data) {
  await redis.set(`contact:${key}`, JSON.stringify(data), { EX: 60 * 60 * 24 * CONTACT_TTL_DAYS });
}

async function getContact(key) {
  const data = await redis.get(`contact:${key}`);
  return data ? JSON.parse(data) : null;
}

// Reclama la clave de forma atómica (SET NX): devuelve true solo para el primero que llega,
// así dos entregas simultáneas del mismo webhook no envían el evento dos veces.
async function claimEvent(key, ttlSeconds) {
  const res = await redis.set(`event:${key}`, '1', { NX: true, EX: ttlSeconds });
  return res === 'OK';
}

// Libera la clave si el envío a Meta falló, para que el reintento de Kommo sí pase.
async function releaseEvent(key) {
  await redis.del(`event:${key}`);
}

// Teléfono mexicano normalizado a 10 dígitos (acepta +521..., 52..., o 10 dígitos).
// Otros formatos se devuelven solo con dígitos. Menos de 10 dígitos se descarta.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('52')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('521')) return digits.slice(3);
  return digits;
}

// Registra por persona qué leads y qué referencias de anuncio la han traído.
// Si una misma persona aparece con 2+ leads o 2+ anuncios, lo deja en el log (teléfono enmascarado).
async function recordTouch(phone10, leadId, ref) {
  try {
    const base = `person:${phone10}`;
    const ttl = 60 * 60 * 24 * 90; // 90 días
    const leadAdded = await redis.sAdd(`${base}:leads`, String(leadId));
    const refAdded = ref ? await redis.sAdd(`${base}:refs`, ref) : 0;
    await redis.expire(`${base}:leads`, ttl);
    if (ref) await redis.expire(`${base}:refs`, ttl);
    if (!leadAdded && !refAdded) return;
    const leads = await redis.sCard(`${base}:leads`);
    const refs = ref ? await redis.sCard(`${base}:refs`) : 0;
    if (leads > 1 || refs > 1) {
      console.log(`TRASLAPE persona ***${phone10.slice(-4)} leads=${leads} refs=${refs} (nuevo lead=${leadId})`);
    }
  } catch (err) {
    console.error('No se pudo registrar el toque de la persona:', err);
  }
}

// ── FIX: helper para parsear JSON de forma segura ────────────────────────────
async function safeJson(response) {
  const text = await response.text();
  if (!text || text.trim() === '') {
    console.warn(`Kommo API devolvió body vacío (status ${response.status})`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    console.warn(`Kommo API body no es JSON válido (status ${response.status}):`, text.slice(0, 200));
    return null;
  }
}

async function getContactFromKommo(contactId) {
  try {
    const response = await fetch(
      `https://${KOMMO_SUBDOMAIN}.amocrm.com/api/v4/contacts/${contactId}`,
      {
        headers: {
          'Authorization': `Bearer ${KOMMO_TOKEN}`,
          'Content-Type': 'application/json',
        }
      }
    );
    const data = await safeJson(response); // ← FIX
    if (!data) return {};

    const phone = data.custom_fields_values
      ?.find(f => f.field_code === 'PHONE')
      ?.values?.[0]?.value || '';
    const email = data.custom_fields_values
      ?.find(f => f.field_code === 'EMAIL')
      ?.values?.[0]?.value || '';
    console.log(`Contacto obtenido de Kommo API: id=${contactId} nombre=${data.name} tel=${phone}`);
    return {
      name: data.name || '',
      first_name: data.first_name || '',
      last_name: data.last_name || '',
      phone,
      email
    };
  } catch (error) {
    console.error(`Error consultando contacto ${contactId} en Kommo:`, error);
    return {};
  }
}

async function getLeadFromKommo(leadId) {
  try {
    // Buscar contactos vinculados al lead directamente
    const response = await fetch(
      `https://${KOMMO_SUBDOMAIN}.amocrm.com/api/v4/contacts?query=${leadId}`,
      {
        headers: {
          'Authorization': `Bearer ${KOMMO_TOKEN}`,
          'Content-Type': 'application/json',
        }
      }
    );
    const data = await safeJson(response); // ← FIX
    const contacts = data?._embedded?.contacts || [];
    console.log(`Contactos encontrados para lead ${leadId}: ${contacts.length}`);

    if (contacts.length === 0) {
      // Intentar con el endpoint de leads
      const leadResponse = await fetch(
        `https://${KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/${leadId}?with=contacts`,
        {
          headers: {
            'Authorization': `Bearer ${KOMMO_TOKEN}`,
            'Content-Type': 'application/json',
          }
        }
      );
      const leadData = await safeJson(leadResponse); // ← FIX
      if (!leadData) return null;

      console.log(`Lead raw: ${JSON.stringify(leadData?._embedded)}`);
      const contactId = leadData?._embedded?.contacts?.[0]?.id || null;
      if (!contactId) {
        console.warn(`Lead sin contacto vinculado en Kommo: lead=${leadId} — evento se enviará sin teléfono`);
      }
      console.log(`Lead obtenido de Kommo API: lead=${leadId} contact=${contactId}`);
      return contactId;
    }

    // Buscar el contacto con teléfono
    for (const contact of contacts) {
      const contactDetail = await getContactFromKommo(contact.id);
      if (contactDetail.phone) {
        console.log(`Contacto con teléfono encontrado: id=${contact.id} tel=${contactDetail.phone}`);
        return { id: contact.id, data: contactDetail };
      }
    }

    return contacts[0].id;
  } catch (error) {
    console.error(`Error consultando lead ${leadId} en Kommo:`, error);
    return null;
  }
}

async function sendToMetaCAPI(leadData, eventName) {
  const userData = {};

  const phoneHashList = phoneHashes(leadData.phone);
  if (phoneHashList.length) userData.ph = phoneHashList;
  if (leadData.email) userData.em = [hashData(leadData.email)];

  if (leadData.first_name || leadData.last_name) {
    if (leadData.first_name) userData.fn = [hashData(leadData.first_name)];
    if (leadData.last_name)  userData.ln = [hashData(leadData.last_name)];
  } else if (leadData.name && leadData.name !== '…') {
    const parts = leadData.name.trim().split(' ');
    userData.fn = [hashData(parts[0])];
    if (parts[1]) userData.ln = [hashData(parts.slice(1).join(' '))];
  }

  if (leadData.fbc) userData.fbc = leadData.fbc;
  if (leadData.ctwa_clid) userData.ctwa_clid = leadData.ctwa_clid;

  // Identificador externo — usa el ID del lead de Kommo
  if (leadData.id) userData.extern_id = [hashData(String(leadData.id))];

  // Datos de ubicación fijos para Culiacán, Sinaloa
  userData.ct      = [hashData('culiacan')];
  userData.st      = [hashData('sinaloa')];
  userData.zp      = [hashData('80000')];
  userData.country = [hashData('mx')];

  if (Object.keys(userData).length === 0) {
    console.log(`Skipping ${eventName} — sin datos de usuario para lead ${leadData.id}`);
    return;
  }

  const eventId = `${leadData.id}_${eventName}_${Date.now()}`;

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'crm',
        user_data: userData,
        custom_data: {
          lead_id: String(leadData.id),
          ...(eventName === 'Purchase' && {
            currency: 'MXN',
            value: 0
          })
        }
      }
    ]
  };

  const response = await fetch(
    `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json();
  console.log(`Meta CAPI response for ${eventName}:`, JSON.stringify(result));
  if (!response.ok || result.error) {
    throw new Error(`Meta CAPI rechazó ${eventName}: ${JSON.stringify(result.error || result)}`);
  }
  return result;
}

app.post('/webhook/kommo', async (req, res) => {
  try {
    console.log('Webhook recibido:', JSON.stringify(req.body));
    const body = req.body;

    // ── PASO 1: Guardar contactos en Redis ───────────────────────────
    const incomingContacts = body?.contacts?.add || [];
    const contactByLeadId = {};

    for (const contact of incomingContacts) {
      const phone = contact.custom_fields?.find(f => f.code === 'PHONE')
                      ?.values?.[0]?.value || '';
      const contactData = {
        name:       contact.name || '',
        first_name: contact.first_name || '',
        last_name:  contact.last_name || '',
        phone:      phone,
        email:      contact.email || '',
      };

      await saveContact(contact.id, contactData);

      if (contact.linked_leads_id) {
        for (const leadId of Object.keys(contact.linked_leads_id)) {
          await saveContact(`lead_${leadId}`, contactData);
          contactByLeadId[leadId] = contactData;
        }
      }

      console.log(`Contacto guardado en Redis: id=${contact.id} nombre=${contact.name} tel=${phone}`);
    }

    // ── PASO 2: Guardar fbc desde unsorted ──────────────────────────
    const unsortedLeads = body?.unsorted?.add || [];
    for (const item of unsortedLeads) {
      const ref =
        item?.data?.contacts?.[0]?.profiles?.waba?.profile_data?.ref ||
        item?.source_data?.data?.[0]?.ref ||
        item?.source_data?.client?.ref ||
        null;

      if (ref && item.lead_id) {
        const existing = await getContact(`lead_${item.lead_id}`) || {};
        existing.ref = ref; // referencia cruda del anuncio, para medir traslape entre campañas

        if (ref.startsWith('ad:')) {
          const ctwaClid = ref.split(':').slice(2).join(':');
          existing.ctwa_clid = ctwaClid;
          console.log(`ctwa_clid guardado para lead ${item.lead_id}: ${ctwaClid}`);
        } else if (ref.startsWith('fb.')) {
          existing.fbc = ref;
          console.log(`fbc guardado para lead ${item.lead_id}: ${ref}`);
        } else {
          console.log(`ref con formato desconocido para lead ${item.lead_id}: ${ref}`);
        }

        await saveContact(`lead_${item.lead_id}`, existing);
      }

      const sourceRef = item?.source_data?.data?.[0];
      if (sourceRef && item.lead_id) {
        console.log(`source_data raw para lead ${item.lead_id}:`, JSON.stringify(item.source_data));
      }
    }

    // ── PASO 3: Procesar leads ───────────────────────────────────────
    const newLeads    = body?.leads?.add    || [];
    const statusLeads = body?.leads?.status || [];
    const allLeads    = [...newLeads, ...statusLeads];

    for (const lead of allLeads) {
      const statusId  = String(lead.status_id);
      const eventName =
        stageToEventByPipeline[String(lead.pipeline_id)]?.[statusId] ||
        stageToEvent[statusId];
      if (!eventName) continue;

      // Deduplicación por lead + etapa (atómica): ignora reentregas del mismo webhook
      const leadKey = `${lead.id}_${statusId}`;
      if (!(await claimEvent(leadKey, 60 * 60 * 24 * 7))) {
        console.log(`Duplicado ignorado — lead=${lead.id} evento=${eventName}`);
        continue;
      }

      // Buscar contacto: mismo request → Redis por lead_id → API Kommo
      let contactData =
        contactByLeadId[String(lead.id)] ||
        await getContact(`lead_${lead.id}`) ||
        null;

       if (!contactData || !contactData.phone || !contactData.email) {
        console.log(`Contacto no encontrado en Redis para lead ${lead.id}, consultando Kommo API...`);
        const result = await getLeadFromKommo(lead.id);
        if (result) {
          if (typeof result === 'object' && result.data) {
            contactData = result.data;
            await saveContact(`lead_${lead.id}`, contactData);
            await saveContact(result.id, contactData);
          } else {
            contactData = await getContactFromKommo(result);
            await saveContact(`lead_${lead.id}`, contactData);
            await saveContact(result, contactData);
          }
        }
      }

      const fbcData = await getContact(`lead_${lead.id}`) || {};

      const leadData = {
        id:         lead.id,
        name:       contactData?.name       || '',
        first_name: contactData?.first_name || '',
        last_name:  contactData?.last_name  || '',
        phone:      contactData?.phone      || '',
        email:      contactData?.email      || '',
        fbc:        fbcData.fbc             || '',
        ctwa_clid:  fbcData.ctwa_clid       || '',
      };

      let personKey = null;
      try {
        // Deduplicación por persona: si el mismo teléfono ya generó este evento en la ventana
        // (otro lead, otra campaña), no se vuelve a contar en Meta.
        const phone10 = normalizePhone(leadData.phone);
        if (phone10) {
          await recordTouch(phone10, lead.id, fbcData.ref || fbcData.ctwa_clid || fbcData.fbc || '');
          const key = `p_${phone10}_${eventName}`;
          if (!(await claimEvent(key, 60 * 60 * 24 * PERSON_DEDUPE_DAYS))) {
            console.log(`Duplicado por persona ignorado — lead=${lead.id} evento=${eventName} persona=***${phone10.slice(-4)}`);
            continue;
          }
          personKey = key;
        }

        console.log(`Enviando a Meta — evento=${eventName} lead=${lead.id} tel=${leadData.phone} email=${leadData.email} nombre=${leadData.name}`);
        await sendToMetaCAPI(leadData, eventName);
      } catch (err) {
        // Si Meta falló, se liberan las claves para que el reintento de Kommo no se descarte.
        await releaseEvent(leadKey);
        if (personKey) await releaseEvent(personKey);
        throw err;
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error procesando webhook:', error);
    res.sendStatus(500);
  }
});

// Endpoint para reenvío manual
app.get('/webhook/reenviar/:leadId', async (req, res) => {
  const { leadId } = req.params;
  const { phone, name, email, event } = req.query;
  const leadData = { id: leadId, phone, name, email, fbc: '', ctwa_clid: '' };
  try {
    await sendToMetaCAPI(leadData, event || 'Purchase');
    res.send(`Evento enviado para lead ${leadId} ✅`);
  } catch (err) {
    console.error('Error en reenvío manual:', err);
    res.status(502).send(`Meta rechazó el evento para lead ${leadId} ❌`);
  }
});

app.get('/webhook/dedupe/:leadId/:statusId', async (req, res) => {
  const key = `event:${req.params.leadId}_${req.params.statusId}`;
  await redis.del(key);
  console.log(`Deduplicación limpiada: ${key}`);
  res.send(`Clave ${key} eliminada ✅`);
});

app.get('/', (req, res) => {
  res.send('Servidor Kommo → Meta CAPI funcionando ✅');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
