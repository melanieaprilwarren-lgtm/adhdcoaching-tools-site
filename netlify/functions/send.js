// netlify/functions/send.js
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };

  try {
    const {
      coach_id, exercise_type, client_name, client_email,
      pdf1, pdf1_name, pdf2, pdf2_name
    } = JSON.parse(event.body || '{}');

    // pdf1 is required. pdf2 is optional because Modalities only sends one PDF.
    if (!coach_id || !client_name || !client_email || !pdf1) {
      return json(400, { error: 'Missing required fields' });
    }

    const coach = await lookupCoach(coach_id);
    const active = !!(coach && coach.active);
    const coachEmail = (active && coach.coach_email) ? String(coach.coach_email).trim() : null;

    const globalFromName = (process.env.FROM_NAME || 'Coaching Exercises').trim();
    const fromName = (coach?.from_name && String(coach.from_name).trim()) || globalFromName;

    const signatureName =
      (coach?.signature && String(coach.signature).trim()) ||
      (coach?.coach_name && String(coach.coach_name).trim()) ||
      (coach?.display_name && String(coach.display_name).trim()) ||
      'Your Coach';

    const fallbackCoach = (process.env.FALLBACK_COACH_EMAIL || process.env.FROM_EMAIL || '').trim();
    if (!fallbackCoach) return json(500, { error: 'No fallback coach email configured' });

    const sgKey = process.env.SENDGRID_API_KEY;
    const fromEmail = process.env.FROM_EMAIL;
    if (!sgKey || !fromEmail) return json(500, { error: 'Missing mail configuration' });

    const attachments = [];

    const a1 = toAttachment(pdf1, pdf1_name || defaultPdfName(exercise_type));
    if (!a1) return json(400, { error: 'Invalid PDF data' });
    attachments.push(a1);

    if (pdf2) {
      const a2 = toAttachment(pdf2, pdf2_name || 'exercise-details.pdf');
      if (!a2) return json(400, { error: 'Invalid second PDF data' });
      attachments.push(a2);
    }

    const copy = makeCopy({
      exercise_type,
      client_name,
      signature: signatureName,
      client_note: coach?.client_email_note,
      coach_note: coach?.coach_email_note,
      hasSecondPdf: !!pdf2
    });

    const send = (p) => fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sgKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(p)
    }).then(async r => { if (!r.ok) throw new Error(await r.text()); });

    await send({
      personalizations: [{ to: [{ email: client_email.trim() }], subject: copy.subjectClient }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email: active ? coachEmail : fallbackCoach },
      content: [{ type: 'text/plain', value: copy.bodyClient }],
      attachments
    });

    await send({
      personalizations: [{ to: [{ email: active ? coachEmail : fallbackCoach }], subject: copy.subjectCoach }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email: client_email.trim() },
      content: [{ type: 'text/plain', value: copy.bodyCoach }],
      attachments
    });

    return json(200, {
      ok: true,
      sent_to_coach: active ? coachEmail : fallbackCoach,
      from_name_used: fromName,
      signature_used: signatureName,
      coach_lookup_found: !!coach,
      coach_active: active
    });

  } catch (e) {
    console.error('send function error', e);
    return json(500, { error: 'Server error', detail: String(e.message || e) });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(code, obj) {
  return { statusCode: code, headers: cors(), body: JSON.stringify(obj) };
}

async function lookupCoach(coach_id) {
  const id = String(coach_id || '').trim().toLowerCase();

  const key = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE_NAME || 'Coaches';

  if (key && base) {
    const formula = `LOWER({coach_id})='${id}'`;
    const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const data = await r.json();
    const rec = (data.records || [])[0];

    if (rec) {
      const f = rec.fields || {};
      return {
        coach_id: f.coach_id,
        coach_name: f.coach_name,
        display_name: f.display_name,
        signature: f.signature,
        coach_email: f.coach_email,
        active: !!f.active,
        from_name: f.from_name,
        client_email_note: f.client_email_note,
        coach_email_note: f.coach_email_note
      };
    }
  }

  try {
    if (process.env.COACHES_JSON) {
      const list = JSON.parse(process.env.COACHES_JSON);
      const found = list.find(c => (String(c.coach_id || '').trim().toLowerCase()) === id) || null;
      if (found) return found;
    }
  } catch (_) {}

  return null;
}

function toAttachment(dataUri, filename) {
  if (typeof dataUri !== 'string') return null;
  const base64 = (dataUri.split(',')[1] || '').trim();
  if (!base64) return null;
  return { content: base64, type: 'application/pdf', filename, disposition: 'attachment' };
}

function defaultPdfName(exercise_type) {
  if (exercise_type === 'modalities') return 'processing-modalities-exercise.pdf';
  if (exercise_type === 'values') return 'core-values-exercise.pdf';
  if (exercise_type === 'life_wheel') return 'life-wheel.pdf';
  return 'exercise.pdf';
}

function exerciseName(exercise_type) {
  if (exercise_type === 'values') return 'Core Values Exercise';
  if (exercise_type === 'life_wheel') return 'Quality of Life Wheel';
  if (exercise_type === 'modalities') return 'Processing Modalities Exercise';
  return 'Coaching Exercise';
}

function makeCopy({ exercise_type, client_name, signature, client_note, coach_note, hasSecondPdf }) {
  const name = client_name || 'Client';
  const exName = exerciseName(exercise_type);
  const subject = `${exName} — ${name}`;

  const pdfWording = hasSecondPdf ? 'Attached are your PDFs' : 'Attached is your PDF';
  const reviewWording = hasSecondPdf ? 'review them together' : 'review it together';
  const coachPdfWording = hasSecondPdf ? 'the PDFs' : 'the PDF';

  const clientParts = [
`Hi ${name},

Thanks for taking the time to complete your ${exName}. This helps inform our work together.

${pdfWording}. I’ve also received a copy so we can ${reviewWording}.

Please reply to this email if you have any questions.`
  ];

  if (client_note && String(client_note).trim()) {
    clientParts.push(String(client_note).trim());
  }

  clientParts.push(
`Kind regards,
${signature || 'Your Coach'}`
  );

  const bodyClient = clientParts.join('\n\n');

  const coachParts = [
`Client: ${name}

Attached is ${coachPdfWording} for the ${exName}.

— Sent automatically from adhdcoaching.tools`
  ];

  if (coach_note && String(coach_note).trim()) {
    coachParts.push(String(coach_note).trim());
  }

  const bodyCoach = coachParts.join('\n\n');

  return {
    subjectClient: subject,
    subjectCoach: subject,
    bodyClient,
    bodyCoach
  };
}
