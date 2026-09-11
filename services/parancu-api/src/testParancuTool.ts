// services/parancu-api/src/testParancuTool.ts

import {
  askParancu,
} from "./parancuTool.js";

const result =
  await askParancu(
    "Dove nacque Ruggero II?"
  );

console.log(
  JSON.stringify(
    result,
    null,
    2
  )
);
