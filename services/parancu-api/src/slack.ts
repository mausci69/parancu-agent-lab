// services/parancu-api/src/slack.ts

import {
  runAgent,
} from "./agent.js";

import {
  prepareParancu,
} from "./parancuTool.js";

import {
  App,
} from "@slack/bolt";

const botToken =
  process.env.SLACK_BOT_TOKEN?.trim();

const appToken =
  process.env.SLACK_APP_TOKEN?.trim();

if (
  !botToken ||
  !appToken
) {
  throw new Error(
    "Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN."
  );
}

const app =
  new App({
    token:
      botToken,

    appToken:
      appToken,

    socketMode:
      true,
  });

app.event(
  "app_mention",
  async ({
    event,
    say,
  }) => {
    const question =
      event.text
        .replace(
          /<@[^>]+>/g,
          ""
        )
        .trim();

    const userId =
      event.user;

    const threadId =
      event.thread_ts ??
      event.ts;

    const environmentId =
      `slack:${userId}:${threadId}`;

    const files =
      Array.isArray(
        (event as any).files
      )
        ? (event as any).files
        : [];

    console.log(
      "ENVIRONMENT:",
      environmentId
    );

    console.log(
      "SLACK FILES:",
      files.length
    );

    if (files.length > 0) {
      const file =
        files[0];

      if (
        file?.mimetype !==
          "text/plain"
      ) {
        await say({
          text:
            "Unsupported file type. Please attach a .txt file.",

          thread_ts:
            threadId,
        });

        return;
      }

      if (!file?.url_private) {
        await say({
          text:
            "I could not access the attached file.",

          thread_ts:
            threadId,
        });

        return;
      }

      const response =
        await fetch(
          file.url_private,
          {
            headers: {
              Authorization:
                `Bearer ${botToken}`,
            },
          }
        );

      if (!response.ok) {
        throw new Error(
          `Slack file download failed: HTTP ${response.status}`
        );
      }

      const text =
        await response.text();

      await prepareParancu(
        text,
        "it",
        environmentId
      );

      console.log(
        "PARANCU PREPARED"
      );
    } else {
      console.log(
        "USING THREAD CORPUS"
      );
    }

    try {
      const answer =
        await runAgent(
          question,
          environmentId
        );

      await say({
        text:
          answer,

        thread_ts:
          threadId,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        message.includes(
          "No corpus found for this environment"
        )
      ) {
        await say({
          text:
            "No corpus is loaded in this thread. Attach a text file first.",

          thread_ts:
            threadId,
        });

        return;
      }

      throw error;
    }
  }
);

await app.start();

console.log(
  "ParancU Slack agent running."
);