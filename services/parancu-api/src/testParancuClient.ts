// services/parancu-api/src/testParancuClient.ts

import {
  ParancuClient,
} from "./parancuClient.js";

const client =
  new ParancuClient();

const text =
  [
    "Ruggero II nacque a Mileto nel 1095.",
    "Divenne re di Sicilia nel 1130.",
    "Palermo fu una delle città principali del suo regno.",
    "La sua corte riunì studiosi e funzionari di culture diverse.",
  ].join(" ");

const prepared =
  await client.prepare(
    text,
    "it"
  );

console.log(
  "PREPARE:",
  JSON.stringify(
    prepared,
    null,
    2
  )
);

const corpus =
  await client.corpus();

console.log(
  "CORPUS:",
  JSON.stringify(
    corpus,
    null,
    2
  )
);

const result =
  await client.query(
    "Dove nacque Ruggero II?"
  );

console.log(
  "QUERY:",
  JSON.stringify(
    result,
    null,
    2
  )
);