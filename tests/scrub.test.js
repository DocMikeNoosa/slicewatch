const { scrub, guessFields } = require("../web/scrub.js");
const now = new Date(2026, 9, 10);
const sample = `RADIOLOGY REQUEST
Patient Name: SMITH, John Alan     DOB: 14/03/1958     MRN: 00482913
NHS No: 943 476 5919
Address: 12 Rose Lane, Leeds LS6 2QT   Tel: 0113 496 0000
Sex: M
Referring Doctor: Dr Jane Patel
Exam: CT head non-contrast
Clinical history: 67-year-old man with sudden severe headache 3 hours ago, on apixaban. Mr Smith had a fall on 02/10/2026. Headache for 3 years. Hb 120 140 150.
Clinical question: Haemorrhage? Mass effect?`;
const r = scrub(sample, now);
console.log(r.text); console.log(JSON.stringify({ removed: r.removed, age: r.age, sex: r.sex }));
console.log(JSON.stringify(guessFields(r.text)));
const leaks = ["Smith","SMITH","John","Alan","1958","00482913","943 476 5919","Rose","LS6","0113","Patel","Jane"].filter(x => r.text.includes(x));
console.log("LEAKS:", leaks.length ? leaks : "none");
for (const s of ["DOE^JANE^M  F  02-Feb-1971 Acc# A123456", "Name: Maria Garcia Lopez\nAge: 45 F\nHistory: RUQ pain, fever. Query cholecystitis.", "72M SOB, ?PE. Hx DVT.", "CT, Chest with contrast. Left, Right lungs."]) {
  const x = scrub(s, now); console.log("---\n" + x.text, JSON.stringify({ age: x.age, sex: x.sex }));
}
if (leaks.length) { console.error("Identifiers leaked:", leaks); process.exit(1); }
if (r.age !== "60s" || r.sex !== "Male") { console.error("Age band or sex not extracted"); process.exit(1); }
console.log("scrub test passed");
