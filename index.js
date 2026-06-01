const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PIXEL_ID = process.env.PIXEL_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

const stageToEvent = {
  '70153595': 'Lead',
  '70153607': 'Contact',
  '70153599': 'Contact',
  '70153530': 'ViewContent',
  '70153006': 'Schedule',
  '27734908': 'Cancel',
};

const hashData = (value) => {
  if (!value) return null;
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
};

// Cache temporal para guardar datos de contactos mientras llega el lead
const contactCache = {};

async function sendToMetaCAPI(leadData, eventName) {
  const userData = {};

  if (leadData.phone) userData.ph = [hashData(leadData.phone)];
  if (leadData.email) userData.em = [hashData(leadData.email)];

  if (leadData.name) {
    const parts = leadData.name.trim().split(' ');
    userData.fn = [hashData(parts[0])];
    if (parts[1]) userData.ln = [hashData(parts.slice(1).join(' '))];
  }

  // Agregar fbc si viene del anuncio de Meta
  if (leadData.fbc) userData.fbc = leadData.fbc;

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'crm',
        user_data: userData,
        custom_data: {
          lead_id: String(leadData.id),
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

    // ── 1. Guardar contactos en caché cuando llegan ──────────────────
    const incomingContacts = body?.contacts?.add || [];
    for (const contact of incomingContacts) {
      const phone = contact.custom_fields?.find(f => f.code === 'PHONE')
                      ?.values?.[0]?.value || '';
      contactCache[contact.id] = {
        name:  contact.name || '',
        phone: phone,
        email: contact.email || '',
      };
    }

    // ── 2. Guardar fbc desde unsorted (cuando llega el lead nuevo) ───
    const unsortedLeads = body?.unsorted?.add || [];
    for (const item of unsortedLeads) {
      const ref = item?.source_data?.data?.[0] !== undefined
        ? item?.data?.contacts?.[0]?.profiles?.waba?.profile_data?.ref
        : null;
      if (ref && item.lead_id) {
        if (!contactCache[`lead_${item.lead_id}`]) {
          contactCache[`lead_${item.lead_id}`] = {};
        }
        contactCache[`lead_${item.lead_id}`].fbc = ref;
      }
    }

    // ── 3. Procesar cambios de estado ────────────────────────────────
    const newLeads    = body?.leads?.add    || [];
    const statusLeads = body?.leads?.status || [];
    const allLeads    = [...newLeads, ...statusLeads];

    for (const lead of allLeads) {
      const statusId  = String(lead.status_id);
      const eventName = stageToEvent[statusId];
      if (!eventName) continue;

      // Buscar el contacto vinculado al lead
      const linkedContactId = lead.linked_contacts_id
        ? Object.keys(lead.linked_contacts_id)[0]
        : null;

      const contactData = linkedContactId
        ? contactCache[linkedContactId] || {}
        : {};

      const fbcData = contactCache[`lead_${lead.id}`] || {};

      const leadData = {
        id:    lead.id,
        name:  contactData.name  || '',
        phone: contactData.phone || '',
        email: contactData.email || '',
        fbc:   fbcData.fbc       || '',
      };

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
