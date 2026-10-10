/* Removes patient identifiers from clinical text on this computer, before anything is sent.
   Also pulls out an age band and sex so they can be sent without the identifying detail behind them. */
(function (root) {
  "use strict";

  const TITLES = new Set(["mr", "mrs", "ms", "miss", "mx", "master", "dr", "prof", "sir", "dame"]);
  // Words that look like names in a "SURNAME, First" pattern but are clinical.
  const NOT_NAMES = new Set(["ct", "cta", "ctpa", "mri", "mra", "pet", "xr", "us", "ed", "icu", "kub", "cap", "head", "chest", "neck",
    "abdomen", "pelvis", "brain", "spine", "contrast", "left", "right", "bilateral", "history", "clinical", "indication", "urgent", "routine",
    "stat", "male", "female", "none", "nil", "yes", "no", "query", "exam", "study", "request", "reason", "question", "findings", "pain",
    "fever", "trauma", "fall", "known", "previous", "prior", "new", "acute", "chronic", "the", "and", "with", "for", "from", "patient", "age", "sex"]);
  const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const DATE_RE = new RegExp(
    "\\b\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{2,4}\\b" +
    "|\\b\\d{4}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{1,2}\\b" +
    "|\\b\\d{1,2}(?:st|nd|rd|th)?[ \\-](?:" + MONTHS + ")\\.?[ \\-,]*\\d{2,4}\\b" +
    "|\\b(?:" + MONTHS + ")\\.?[ \\-]\\d{1,2}(?:st|nd|rd|th)?,?[ \\-]\\d{2,4}\\b", "gi");

  const LABELS = {
    name: /^(?:patient(?:'s)?\s*name|pt\.?\s*name|name|patient|surname|last\s*name|family\s*name|first\s*names?|given\s*names?|fore\s*names?|full\s*name|middle\s*name)$/i,
    dob: /^(?:dob|d\.o\.b\.?|date\s*of\s*birth|birth\s*date|born)$/i,
    id: /^(?:mrn|m\.r\.n\.?|nhs(?:\s*(?:no\.?|number))?|chi(?:\s*no\.?)?|hospital\s*(?:no\.?|number|id)|patient\s*id|pt\s*id|id|ur(?:n)?(?:\s*no\.?)?|accession(?:\s*(?:no\.?|number))?|acc(?:\s*no\.?)?|medicare(?:\s*no\.?)?|ssn|social\s*security(?:\s*number)?|visit(?:\s*(?:no\.?|number|id))?|encounter(?:\s*(?:no\.?|id))?|csn|fin|record\s*(?:no\.?|number)|insurance(?:\s*(?:no\.?|id))?|policy(?:\s*no\.?)?)$/i,
    contact: /^(?:address|addr\.?|home\s*address|street|city|postcode|post\s*code|zip(?:\s*code)?|phone|telephone|tel\.?|mobile|cell|email|e-mail|contact|next\s*of\s*kin|nok|emergency\s*contact)$/i,
    clinician: /^(?:referrer|referring(?:\s*(?:doctor|physician|clinician|provider))?|referred\s*by|requested\s*by|requesting(?:\s*(?:doctor|clinician))?|ordering(?:\s*(?:physician|provider|clinician))?|ordered\s*by|consultant|attending|gp|primary\s*care(?:\s*physician)?|pcp|signed\s*by|author)$/i,
    age: /^(?:age|age\s*\(years\)|age\/sex)$/i,
    sex: /^(?:sex|gender|sex\/gender)$/i,
  };

  function ageBand(n) {
    if (!(n >= 0) || n > 120) return "";
    if (n < 1) return "Under 1";
    if (n < 5) return "1–4";
    if (n < 10) return "5–9";
    if (n >= 90) return "90+";
    return Math.floor(n / 10) * 10 + "s";
  }

  function parseDate(s, now) {
    s = s.trim();
    let m, d, mo, y;
    const mi = (t) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(t.slice(0, 3).toLowerCase());
    if ((m = s.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/))) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
    else if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) {
      // Day/month order is ambiguous; it moves the age by under a year, which rarely changes the decade band.
      d = +m[1]; mo = +m[2] - 1; y = +m[3];
      if (mo > 11 && d <= 12) { const t = d; d = mo + 1; mo = t - 1; }
    }
    else if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[ \-]([a-z]+)\.?[ \-,]*(\d{2,4})/i))) { d = +m[1]; mo = mi(m[2]); y = +m[3]; }
    else if ((m = s.match(/^([a-z]+)\.?[ \-](\d{1,2})(?:st|nd|rd|th)?,?[ \-](\d{2,4})/i))) { mo = mi(m[1]); d = +m[2]; y = +m[3]; }
    else return null;
    if (mo < 0 || mo > 11 || !(d >= 1 && d <= 31)) return null;
    if (y < 100) y += (y > now.getFullYear() % 100) ? 1900 : 2000;
    return new Date(y, mo, d);
  }
  function ageFrom(dob, now) {
    let a = now.getFullYear() - dob.getFullYear();
    if (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) a--;
    return a;
  }
  function sexFrom(v) {
    const t = v.trim().toLowerCase();
    if (/^(f|female|woman|girl)\b/.test(t)) return "Female";
    if (/^(m|male|man|boy)\b/.test(t)) return "Male";
    return "";
  }
  const isNameLike = (v) => {
    const words = v.trim().split(/[\s,^]+/).filter(Boolean);
    return words.length >= 1 && words.length <= 5 && !/\d/.test(v) &&
      words.every((w) => /^[A-Z][A-Za-z'\-.]*$/.test(w)) && !words.every((w) => NOT_NAMES.has(w.toLowerCase().replace(/\.$/, "")));
  };
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function scrub(input, now) {
    now = now || new Date();
    const removed = { names: 0, dob: 0, ids: 0, contact: 0, dates: 0 };
    let age = "", sex = "";
    const nameTokens = new Set();
    const addTokens = (v) => v.split(/[\s,^]+/).forEach((w) => {
      const t = w.replace(/[^A-Za-z'\-]/g, "");
      if (t.length > 1 && !TITLES.has(t.toLowerCase()) && !NOT_NAMES.has(t.toLowerCase())) nameTokens.add(t.toLowerCase());
    });

    // 1. "Label: value" pairs, several may share a line (e.g. "Name: X   DOB: Y   MRN: Z").
    //    OCR often collapses the gaps between fields to one space, so put a tab before every known label first.
    const LABEL_SPLIT = new RegExp("\\s(?=(?:" + Object.values(LABELS).map((r) => r.source.replace(/^\^|\$$/g, "")).join("|") + ")\\s*[:#=])", "gi");
    const lines = String(input || "").replace(/\r/g, "").split("\n").map((l) => l.replace(LABEL_SPLIT, "\t").replace(/\b(patient(?:'s)?|pt\.?|first|last|family|given|full|middle|fore|hospital|home|post|zip|next\s+of|emergency|date\s+of|birth|social\s+security|record|accession|visit|encounter|insurance|policy|nhs|chi|acc|medicare|referring|requesting|ordering|primary\s+care|e)\t/gi, "$1 ")).map((line) => {
      const parts = line.split(/(\s{2,}|\t|\s+\|\s+|;\s+)/);
      return parts.map((seg) => {
        const m = seg.match(/^(\s*)([A-Za-z][A-Za-z .'\/()]{0,40}?)\s*[:#=]\s*(.*)$/);
        if (!m) return seg;
        const [, lead, rawLabel, value] = m;
        const label = rawLabel.trim();
        if (!value.trim()) return seg;
        if (LABELS.dob.test(label)) {
          const d = parseDate(value, now);
          if (d) { const a = ageFrom(d, now); if (a >= 0 && a < 121) age = age || ageBand(a); }
          removed.dob++; return `${lead}${label}: [removed]`;
        }
        if (LABELS.id.test(label)) { removed.ids++; return `${lead}${label}: [removed]`; }
        if (LABELS.contact.test(label)) { removed.contact++; return `${lead}${label}: [removed]`; }
        if (LABELS.clinician.test(label)) { if (/[A-Za-z]/.test(value)) { removed.names++; return `${lead}${label}: [clinician]`; } return seg; }
        if (LABELS.age.test(label)) {
          const n = value.match(/\d{1,3}/); if (n) age = age || ageBand(+n[0]);
          const s = sexFrom(value.replace(/^[\d\s]*(?:y(?:ea)?rs?|yo|y\/o)?[\s\/,]*/i, "")); if (s) sex = sex || s;
          return `${lead}${label}: [${age || "age removed"}]`;
        }
        if (LABELS.sex.test(label)) { const s = sexFrom(value); if (s) sex = sex || s; return seg; }
        if (LABELS.name.test(label) && isNameLike(value)) { addTokens(value); removed.names++; return `${lead}${label}: [name]`; }
        return seg;
      }).join("");
    });
    let t = lines.join("\n");

    // 2. Name shapes without labels.
    t = t.replace(/\b([A-Z][A-Z'\-]+)\^([A-Z][A-Za-z'\-]+)(?:\^[A-Za-z'\-]*)*/g, (m, a, b) => { addTokens(a + " " + b); removed.names++; return "[name]"; });
    t = t.replace(/\b([A-Z][A-Z'\-]{2,}),\s*([A-Z][a-z'\-]+(?:\s+[A-Z][a-z'\-]+)?)\b/g, (m, a, b) => {
      if (NOT_NAMES.has(a.toLowerCase()) || NOT_NAMES.has(b.split(/\s+/)[0].toLowerCase())) return m;
      addTokens(a + " " + b); removed.names++; return "[name]";
    });
    t = t.replace(/\b(Mr|Mrs|Ms|Miss|Mx|Master|Dr|Prof)\.?\s+((?:[A-Z][A-Za-z'\-]+)(?:\s+[A-Z][A-Za-z'\-]+)?)/g, (m, title, nm) => {
      if (NOT_NAMES.has(nm.split(/\s+/)[0].toLowerCase())) return m;
      if (title !== "Dr" && title !== "Prof") addTokens(nm);
      removed.names++; return `${title} [name]`;
    });
    // Every other appearance of a name we have learned (e.g. "Smith was seen…").
    for (const tok of nameTokens) {
      const re = new RegExp("\\b" + escRe(tok) + "\\b", "gi");
      t = t.replace(re, () => { removed.names++; return "[name]"; });
    }
    t = t.replace(/\[name\](?:[\s,]*\[name\])+/g, "[name]");

    // 3. Dates, contact details and long numbers anywhere.
    t = t.replace(/\b[\w.+\-]+@[\w\-]+\.[\w.\-]+\b/g, () => { removed.contact++; return "[removed]"; });
    t = t.replace(DATE_RE, () => { removed.dates++; return "[date]"; });
    t = t.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g, () => { removed.contact++; return "[removed]"; }); // UK postcode
    t = t.replace(/(?:\+\d{1,3}[\s\-]?)?(?:\(\d{2,5}\)[\s\-]?)?\d{3,5}[\s\-]\d{3,4}[\s\-]?\d{3,4}\b/g, (m) => {
      if (m.replace(/\D/g, "").length < 10) return m; // short runs are more likely lab values than phone numbers
      removed.contact++; return "[removed]";
    });
    t = t.replace(/\b[A-Z]{0,3}\d{6,}[A-Z]?\b/g, () => { removed.ids++; return "[removed]"; });
    t = t.replace(/\b\d{3}[\s\-]\d{2}[\s\-]\d{4}\b/g, () => { removed.ids++; return "[removed]"; }); // SSN shape

    // 4. Exact ages in running text become the band.
    t = t.replace(/\b(\d{1,3})\s*[\s\-]\s*(?:years?|yrs?)[\s\-]*old\b|\b(\d{1,3})\s*(?:yo|y\/o|y\.o\.?)(?=[\s,.;:)]|$)/gi, (m, a, b) => {
      const n = +(a || b); if (n > 120) return m;
      const band = ageBand(n); age = age || band; return `[${band}]`;
    });
    t = t.replace(/\b(\d{1,3})([MF])\b/g, (m, a, g) => {
      const n = +a; if (n > 120) return m;
      const band = ageBand(n); age = age || band; sex = sex || (g === "M" ? "Male" : "Female"); return `[${band} ${g === "M" ? "male" : "female"}]`;
    });
    if (!sex) {
      if (/\b(?:female|woman|lady|girl|she|her)\b/i.test(t)) sex = "Female";
      else if (/\b(?:male|man|gentleman|boy|he|his)\b/i.test(t)) sex = "Male";
    }
    t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text: t, removed, age, sex };
  }

  // Best guess at the study and the clinical question from request text.
  function guessFields(text) {
    const s = text.toLowerCase(), out = {};
    const studies = [
      [/ctpa|pulmonary angio|ct pa\b|pe protocol/, "CT pulmonary angiogram"],
      [/cta.*(head|neck|carotid|circle)|ct angio.*(head|neck)|stroke protocol/, "CT angiogram head/neck"],
      [/c[\s\-]?spine|cervical spine/, "CT cervical spine"],
      [/\bkub\b|renal colic|ureteric/, "CT KUB"],
      [/aort/, "CT aorta"],
      [/chest.*abd.*pelvis|\bcap\b|c\/a\/p/, "CT chest/abdomen/pelvis"],
      [/abd(omen)?.*pelvis|\bct ap\b|a\/p/, "CT abdomen/pelvis"],
      [/ct (head|brain)|head ct|non[\s\-]?contrast head/, "CT head non-contrast"],
      [/ct chest|chest ct|hrct/, "CT chest"],
    ];
    for (const [re, v] of studies) if (re.test(s)) { out.study = v; break; }
    const phases = [[/portal venous|pv phase/, "Portal venous"], [/arterial/, "Arterial"], [/delayed/, "Delayed"], [/non[\s\-]?contrast|without contrast|unenhanced|plain/, "Non-contrast"]];
    for (const [re, v] of phases) if (re.test(s)) { out.phase = v; break; }
    const q = text.match(/(?:clinical question|question|query|reason for (?:exam|study|request|scan)|indication)\s*[:\-]\s*(.+)/i);
    if (q) out.question = q[1].trim().slice(0, 300);
    return out;
  }

  const api = { scrub, guessFields, ageBand };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SWScrub = api;
})(typeof window !== "undefined" ? window : globalThis);
