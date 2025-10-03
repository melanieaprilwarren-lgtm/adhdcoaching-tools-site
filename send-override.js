// send-override.js
(function () {
  // Get coach id from ?c=... or subdomain (future)
  function getCoachId() {
    const q = new URLSearchParams(location.search).get('c');
    if (q) return q.toLowerCase();
    const parts = location.hostname.split('.');
    if (parts.length > 2) return parts[0].toLowerCase();
    return 'meltest';
  }

  async function sendViaAPI(payload) {
    const res = await fetch('/.netlify/functions/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  function normalize(p) {
    p = p || {};
    return {
      coach_id: getCoachId(),
      exercise_type: location.pathname.toLowerCase().includes('values') ? 'values' : 'life_wheel',
      client_name:  (p.client_name  || p.user_name || p.name    || '').trim(),
      client_email: (p.client_email || p.user_email|| p.email   || p.reply_to || '').trim(),
      pdf1:        p.pdf1 || p.pdf_file1,
      pdf1_name:   p.pdf1_name || p.pdf_file1_name || 'exercise.pdf',
      pdf2:        p.pdf2 || p.pdf_file2,
      pdf2_name:   p.pdf2_name || p.pdf_file2_name || 'exercise-details.pdf'
    };
  }

  // Hard override any EmailJS usage on the page so it routes to our Netlify Function
  window.emailjs = window.emailjs || {};
  window.emailjs.init = function(){};
  window.emailjs.send = async function(_svc, _tpl, params){ return sendViaAPI(normalize(params)); };
  window.emailjs.sendForm = async function(_svc, _tpl, form){
    const fd = new FormData(form);
    const params = Object.fromEntries(fd.entries());
    return window.emailjs.send(_svc,_tpl,params);
  };
})();
