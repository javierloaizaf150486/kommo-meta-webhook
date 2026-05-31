const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PIXEL_ID = process.env.PIXEL_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

// Mapeo de etapas de Kommo a eventos de Meta
// Cambia los IDs según tus etapas reales
const stageToEvent = {
  '70153595': 'Lead',           // Lead entrante
  '70153607': 'Contact',        // Contacto inicial
  '70153599': 'Contact',        // Reanudar contacto
  '70153530': 'ViewContent',    // Precio
  '70153006': 'Schedule',       // Agenda ⭐
  '27734908': 'Cancel',         // No agendar
};

const hashData = (value) => {
  if (!value) return null;
  return crypto
    .createHash('sha256')
    .update(value.toLowerCase().trim())
    .digest('hex');
};

async function sendToMetaCAPI(leadData, eventName) {
  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'crm',
        user_data: {
          em: leadData.email ? [hashData(leadData.email)] : [],
          ph: leadData.phone ? [hashData(leadData.phone)] : [],
          fn: leadData.name  ? [hashData(leadData.name.split(' ')[0])] : [],
          ln: leadData.name  ? [hashData(leadData.name.split(' ')[1] || '')] : [],
        },
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

// Endpoint que recibe los webhooks de Kommo
app.post('/webhook/kommo', async (req, res) => {
  try {
    console.log('Webhook recibido:', JSON.stringify(req.body));

    const newLeads   = req.body?.leads?.add    || [];
    const statusLeads = req.body?.leads?.status || [];
    const allLeads   = [...newLeads, ...statusLeads];

    for (const lead of allLeads) {
      const statusId  = String(lead.status_id);
      const eventName = stageToEvent[statusId];

      if (eventName) {
        const leadData = {
          id:    lead.id,
          email: lead.contact?.email || '',
          phone: lead.contact?.phone || '',
          name:  lead.contact?.name  || '',
        };
        await sendToMetaCAPI(leadData, eventName);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error procesando webhook:', error);
    res.sendStatus(500);
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Servidor Kommo → Meta CAPI funcionando ✅');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
