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
  '80101915': 'Purchase',  // ← Acudió a Cita
};

const hashData = (value) => {
  if (!value) return null;
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
};

async function saveContact(key, data) {
  await redis.set(`contact:${key}`, JSON.stringify(data), { EX: 60 * 60 * 24 }); // 24 horas
}

async function getContact(key) {
  const data = await redis.get(`contact:${key}`);
  return data ? JSON.parse(data) : null;
}

async function isEventSent(key) {
  return await redis.exists(`event:${key}`);
}

async function markEventSent(key) {
  await redis.set(`event:${key}`, '1', { EX: 60 * 60 * 24 * 7 }); // 7 días
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
    const data = await response.json();
    const phone = data.custom_fields_values
      ?.find(f => f.field_code === 'PHONE')
      ?.values?.[0]?.value || '';
    const email = data.custom_fields_values
      ?.find(f => f.field_code === 'EMAIL')
      ?.values?.[0]?.value || '';
    console.log(`Contacto obtenido de Kommo API: id=${contactId} nombre=${data.name} tel=${phone}`);
    return { name: data.name || '', phone, email };
  } catch (error) {
    console.error(`Error consultando contacto ${contactId} en Kommo:`, error);
    return {};
  }
}

async function getLeadFromKommo(leadId) {
  try {
    const response = await fetch(
      `https://${KOMMO_SUBDOMAIN}.amocrm.com/api/v4/leads/${leadId}?with=contacts`,
      {
        headers: {
          'Authorization': `Bearer ${KOMMO_TOKEN}`,
          'Content-Type': 'application/json',
        }
      }
    );
    const data = await response.json();
    const contactId =
      data?._embedded?.contacts?.[0]?.id ||
      data?.contacts?.[0]?.id ||
      null;
    console.log(`Lead obtenido de Kommo API: lead=${leadId} contact=${contactId}`);
    return contactId;
  } catch (error) {
    console.error(`Error consultando lead ${leadId} en Kommo:`, error);
    return null;
  }
}

async function if (leadData.first_name || leadData.last_name) {
  if (leadData.first_name) userData.fn = [hashData(leadData.first_name)];
  if (leadData.last_name)  userData.ln = [hashData(leadData.last_name)];
} else if (leadData.name && leadData.name !== '…') {
  const parts = leadData.name.trim().split(' ');
  userData.fn = [hashData(parts[0])];
  if (parts[1]) userData.ln = [hashData(parts.slice(1).join(' '))];
}

 if (leadData.fbc) userData.fbc = leadData.fbc;

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
  // Buscar ref en múltiples ubicaciones
  const ref =
    item?.data?.contacts?.[0]?.profiles?.waba?.profile_data?.ref ||
    item?.source_data?.data?.[0]?.ref ||
    item?.source_data?.client?.ref ||
    null;

  if (ref && item.lead_id) {
    // Convertir ref a formato fbc válido de Meta
    const fbc = ref.startsWith('fb.') ? ref : `fb.1.${Date.now()}.${ref}`;
    const existing = await getContact(`lead_${item.lead_id}`) || {};
    existing.fbc = fbc;
    await saveContact(`lead_${item.lead_id}`, existing);
    console.log(`fbc guardado para lead ${item.lead_id}: ${fbc}`);
  }

  // También buscar en source_data directo
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
      const eventName = stageToEvent[statusId];
      if (!eventName) continue;

      // Deduplicación con Redis
      const dedupeKey = `${lead.id}_${statusId}`;
      if (await isEventSent(dedupeKey)) {
        console.log(`Duplicado ignorado — lead=${lead.id} evento=${eventName}`);
        continue;
      }
      await markEventSent(dedupeKey);

      // Buscar contacto: mismo request → Redis por lead_id → API Kommo
      let contactData =
        contactByLeadId[String(lead.id)] ||
        await getContact(`lead_${lead.id}`) ||
        null;

      if (!contactData || (!contactData.phone && !contactData.email)) {
        console.log(`Contacto no encontrado en Redis para lead ${lead.id}, consultando Kommo API...`);
        const contactId = await getLeadFromKommo(lead.id);
        if (contactId) {
          contactData = await getContactFromKommo(contactId);
          await saveContact(`lead_${lead.id}`, contactData);
          await saveContact(contactId, contactData);
        }
      }

      const fbcData = await getContact(`lead_${lead.id}`) || {};

      const leadData = {
        id:    lead.id,
        name:  contactData?.name  || '',
        phone: contactData?.phone || '',
        email: contactData?.email || '',
        fbc:   fbcData.fbc        || '',
      };

      console.log(`Enviando a Meta — evento=${eventName} lead=${lead.id} tel=${leadData.phone} nombre=${leadData.name}`);
      await sendToMetaCAPI(leadData, eventName);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error procesando webhook:', error);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('Servidor Kommo → Meta CAPI funcionando ✅');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
