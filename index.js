app.post('/webhook/kommo', async (req, res) => {
  try {
    console.log('Webhook recibido:', JSON.stringify(req.body));
    const body = req.body;

    // ── PASO 1: Indexar contactos del body actual por lead_id ────────
    const incomingContacts = body?.contacts?.add || [];
    const contactByLeadId = {};

    for (const contact of incomingContacts) {
      const phone = contact.custom_fields?.find(f => f.code === 'PHONE')
                      ?.values?.[0]?.value || '';
      const contactData = {
        name:  contact.name || '',
        phone: phone,
        email: contact.email || '',
      };

      // Guardar en caché por contact_id
      contactCache[contact.id] = contactData;

      // Indexar también por cada lead vinculado
      if (contact.linked_leads_id) {
        for (const leadId of Object.keys(contact.linked_leads_id)) {
          contactByLeadId[leadId] = contactData;
        }
      }

      console.log(`Contacto guardado: id=${contact.id} nombre=${contact.name} tel=${phone}`);
    }

    // ── PASO 2: Guardar fbc desde unsorted ──────────────────────────
    const unsortedLeads = body?.unsorted?.add || [];
    for (const item of unsortedLeads) {
      const ref = item?.data?.contacts?.[0]?.profiles?.waba?.profile_data?.ref;
      if (ref && item.lead_id) {
        if (!contactCache[`lead_${item.lead_id}`]) {
          contactCache[`lead_${item.lead_id}`] = {};
        }
        contactCache[`lead_${item.lead_id}`].fbc = ref;
        console.log(`fbc guardado para lead ${item.lead_id}`);
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

      // Buscar contacto: primero en el body actual, luego en caché
      const contactData =
        contactByLeadId[String(lead.id)] ||
        contactCache[lead.linked_contacts_id
          ? Object.keys(lead.linked_contacts_id)[0]
          : null] ||
        {};

      const fbcData = contactCache[`lead_${lead.id}`] || {};

      const leadData = {
        id:    lead.id,
        name:  contactData.name  || '',
        phone: contactData.phone || '',
        email: contactData.email || '',
        fbc:   fbcData.fbc       || '',
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
