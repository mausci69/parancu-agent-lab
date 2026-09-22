import { coordinate } from "./coordinator/coordinator";

const tests = [
  "When did the Normans arrive in Sicily?",
  "Who was Roger II?",
  "C'è qualcosa sulla nascita di Ruggero II?",
  "Hello",
  "Thanks",
  "Ciao",
  "Grazie",
];

for (const input of tests) {
  console.log("\nUSER:");
  console.log(input);

  console.log("\nCOORDINATOR:");
  console.log(coordinate(input));
}
