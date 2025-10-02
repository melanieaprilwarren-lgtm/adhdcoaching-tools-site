exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };

  try {
    const {
      coach_id, exercise_type, client_name, client_email,
      pdf1, pdf1_name, pdf2, pdf2_name
    } = JSON.parse(event.body || '{}');

    if (!coach_id || !client_name || !client_email || !pdf1 || !pdf2) {
      return json(400, { error: 'Missing required fields' });
    }

    const coach = await lookupCoach(coach_id);
    const active = !!(coach && coach.active);
    const coachEmail = (active && coach.coach_email) ? String(coach.coach_email).trim() : null;
    const fallbackCoach = (process.env.FALLBACK_COACH_EMAIL || process.env.FROM_EMAIL || '').trim();
    if (!fallbackCoach) return json(500, { error: 'No fallback coach email configured' });

    const { subjectClient, bodyClient, subjectCoach, bodyCoach } =
      makeCopy({ exercise_type, client_name, coach_name: coach?.coach_name });

    const a1 = toAttachment(pdf1, pdf1_name || 'exercise.pdf');
    const a2 = toAttachment(pdf2, pdf2_name || 'exercise-details.pdf');
    if (!a1 || !a2) return json(400, { error: 'Invalid PDF data' });

    const sgKey = process.env.SENDGRID_API_KEY;
    const fromEmail = process.env.FROM_EMAIL;
    const fromName  = process.env.FROM_NAME || 'Coaching Exercises';
    if (!sgKey || !fromEmail) return json(500, { error: 'Missing mail configuration' });

    const send = (p) => fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sgKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(p)
    }).then(async r => { if (!r.ok) throw new Error(await r.text()); });

    // 1) Client copy (Reply-To = coach if active, else you)
    await send({
      personalizations: [{ to: [{ email: client_email.trim() }], subject: subjectClient }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email: active ? coachEmail : fallbackCoach },
      content: [{ type: 'text/plain', value: bodyClient }],
      attachments: [a1, a2]
    });

    // 2) Coach (or fallback) copy (Reply-To = client)
    await send({
      personalizations: [{ to: [{ email: active ? coachEmail : fallbackCoach }], subject: subjectCoach }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email: client_email.trim() },
      content: [{ type: 'text/plain', value: bodyCoach }],
      attachments: [a1, a2]
    });

    return json(200, { ok: true, sent_to_coach: active ? coachEmail : fallbackCoach });
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
function json(code, obj) { return { statusCode: code, headers: cors(), body: JSON.stringify(obj) }; }

async function lookupCoach(coach_id) {
  const id = String(coach_id || '').toLowerCase();

  // Airtable (if configured)
  const key = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE_NAME || 'Coaches';
  if (key && base) {
    const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(`{coach_id}='${id}'`)}&maxRecords=1`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const data = await r.json();
    const rec = (data.records || [])[0];
    if (rec) {
      const f = rec.fields || {};
      return { coach_id: f.coach_id, coach_name: f.coach_name, coach_email: f.coach_email, active: !!f.active };
    }
  }

  // Fallback to env JSON
  try {
    if (process.env.COACHES_JSON) {
      const list = JSON.parse(process.env.COACHES_JSON);
      return list.find(c => (c.coach_id || '').toLowerCase() === id) || null;
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

function makeCopy({ exercise_type, client_name, coach_name }) {
  const name = client_name || 'Client';
  if (exercise_type === 'values') {
    return {
      subjectClient: `Core Values — ${name}`,
      subjectCoach:  `Core Values — ${name}`,
      bodyClient:
`Hi ${name},

Thanks for taking the time to complete your Core Values Exercise. This will help inform our work together.

Attached are your two PDFs. I’ve received a copy as well and will upload them to your CarePatron portal so they’re easy to find later.

Please reply to this email if you have any questions.

Kind regards,
${coach_name || 'Your Coach'}`,
      bodyCoach:
`Client: ${name}

Attached are the two PDFs for the Core Values Exercise.

— Sent automatically from adhdcoaching.tools`
    };
  }
  return {
    subjectClient: `Quality of Life Wheel — ${name}`,
    subjectCoach:  `Quality of Life Wheel — ${name}`,
    bodyClient:
`Hi ${name},

Thanks for taking the time to complete your Quality of Life Wheel. This exercise offers a snapshot of 'now' and will help inform our work together.

Attached are your two PDFs. I’ve received a copy as well and will upload them to your CarePatron portal so they’re easy to find later.

Please reply to this email if you have any questions.

Kind regards,
${coach_name || 'Your Coach'}`,
    bodyCoach:
`Client: ${name}

Attached are the two PDFs for the Quality of Life Wheel.

— Sent automatically from adhdcoaching.tools`
  };
}
