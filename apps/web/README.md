# ParancU local web UI

Static HTML, CSS and browser JavaScript, served by `src/web/server.ts` in the same Node process as the application API. There is no frontend framework or build step.

From the repository root, run `npm run web:local` and open `http://127.0.0.1:3000`. See the root README for dependency installation, environment variables, live-call behavior and limitations.

The browser reads one UTF-8 TXT file and sends `{ name, text, language }` as JSON. It polls preparation status, enables questions only for a ready corpus, and shows the verified answer and accepted citation separately from rejected or unevaluated retrieval candidates. All document/model content is rendered with DOM text nodes, never HTML interpolation.
