// netlify/functions/send.js
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };

  try {
    const {
      coach_id, exercise_type, client_name, client_email,
      pdf1, pdf1_name, pdf2, pdf2_name
    } = JSON.parse(event.body || '{}');

    // Keep existing required fields as-is (safe)
    if (!coach_id || !client_name || !client_email || !pdf1 || !pdf2) {
      return json(400, { error: 'Missing required fields' });
    }

    // Look up coach (Airtable preferred; fallback to COACHES_JSON)
    const coach = await lookupCoach(coach_id);
    const active = !!(coach && coach.active);

    const coachEmail = (active && coach.coach_email) ? String(coach.coach_email).trim() : null;

    // From name (Business / Practice): prefer per-coach Airtable; else global env; else generic.
    const globalFromName = (process.env.FROM_NAME || 'Coaching Exercises').trim();
    const fromName = (coach?.from_name && String(coach.from_name).trim()) || globalFromName;

    // Signature (Human sign-off): prefer Airtable `signature`, else legacy fields.
    const signatureName =
      (coach?.signature && String(coach.signature).trim()) ||
      (coach?.coach_name && String(coach.coach_name).trim()) ||
      (coach?.display_name && String(coach.display_name).trim()) ||
      'Your Coach';

    // Fallback coach email is required if coach is inactive/unknown
    const fallbackCoach = (process.env.FALLBACK_COACH_EMAIL || process.env.FROM_EMAIL || '').trim();
    if (!fallbackCoach) return json(500, { error: 'No fallback coach email configured' });

    const sgKey = process.env.SENDGRID_API_KEY;
    const fromEmail = process.env.FROM_EMAIL;
    if (!sgKey || !fromEmail) return json(500, { error: 'Missing mail configuration' });

    // Build email copy (universal defaults + optional Airtable notes)
    const copy = makeCopy({
      exercise_type,
      client_name,
      signature: signatureName,
      client_note: coach?.client_email_note,
      coach_note: coach?.coach_email_note
    });

    const a1 = toAttachment(pdf1, pdf1_name || 'exercise.pdf');
    const a2 = toAttachment(pdf2, pdf2_name || 'exercise-details.pdf');
    if (!a1 || !a2) return json(400, { error: 'Invalid PDF data' });

    const send = (p) => fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sgKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(p)
    }).then(async r => { if (!r.ok) throw new Error(await r.text()); });

    // 1) Client copy (Reply-To = coach if active, else fallback)
    await send({
      personalizations: [{ to: [{ email: client_email.trim() }], subject: copy.subjectClient }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email: active ? coachEmail : fallbackCoach },
      content: [{ type: 'text/plain', value: copy.bodyClient }],
      attachments: [a1, a2]
    });

    // 2) Coach (or fallback) copy (Reply-To = client)
    await send({
      personalizations: [{ to: [{ email: active ? coachEmail : fallbackCoach }], subject: copy.subjectCoach }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email: client_email.trim() },
      content: [{ type: 'text/plain', value: copy.bodyCoach }],
      attachments: [a1, a2]
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

  // Airtable (preferred)
  const key = process.env.AIRTABLE_API_KEY;
  const base = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE_NAME || 'Coaches';

  if (key && base) {
    // Make lookup case-insensitive to avoid “sometimes it finds it, sometimes it doesn’t”
    const formula = `LOWER({coach_id})='${id}'`;
    const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const data = await r.json();
    const rec = (data.records || [])[0];

    if (rec) {
      const f = rec.fields || {};
      return {
        coach_id: f.coach_id,
        coach_name: f.coach_name,         // legacy supported
        display_name: f.display_name,     // supported
        signature: f.signature,           // NEW preferred field
        coach_email: f.coach_email,
        active: !!f.active,
        from_name: f.from_name,
        client_email_note: f.client_email_note,
        coach_email_note: f.coach_email_note
      };
    }
  }

  // Fallback to env JSON (optional, keeps legacy working)
  try {
    if (process.env.COACHES_JSON) {
      const list = JSON.parse(process.env.COACHES_JSON);
      const found = list.find(c => (String(c.coach_id || '').trim().toLowerCase()) === id) || null;
      if (found) {
        // Normalize keys so the rest of the code works consistently
        return {
          coach_id: found.coach_id,
          coach_name: found.coach_name,
          display_name: found.display_name,
          signature: found.signature,
          coach_email: found.coach_email,
          active: !!found.active,
          from_name: found.from_name,
          client_email_note: found.client_email_note,
          coach_email_note: found.coach_email_note
        };
      }
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

// ===== COPY: universal defaults + optional per-coach notes =====
function makeCopy({ exercise_type, client_name, signature, client_note, coach_note }) {
  const name = client_name || 'Client';
  const exName = (exercise_type === 'values')
    ? 'Core Values Exercise'
    : 'Quality of Life Wheel';

  const subject = `${exName} — ${name}`;

  const baseClient =
`Hi ${name},

Thanks for taking the time to complete your ${exName}. This helps inform our work together.

Attached are your PDFs. I’ve also received a copy so we can review them together.

Please reply to this email if you have any questions.

Kind regards,
${signature || 'Your Coach'}`;

  const baseCoach =
`Client: ${name}

Attached are the PDFs for the ${exName}.

— Sent automatically from adhdcoaching.tools`;

  const bodyClient = client_note ? `${baseClient}\n\n${client_note}` : baseClient;
  const bodyCoach  = coach_note  ? `${baseCoach}\n\n${coach_note}`  : baseCoach;

  return {
    subjectClient: subject,
    subjectCoach:  subject,
    bodyClient,
    bodyCoach
  };
}
