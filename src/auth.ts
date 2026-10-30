
import { readFile, rename, writeFile } from "node:fs/promises";
import type {
  Credential,
  CredentialStore,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export class FileCredentialStore implements CredentialStore {
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private credentials: Record<string, Credential>,
  ) {}

  static async open(path = "./auth.json") {
    const data = JSON.parse(
      await readFile(path, "utf8"),
    ) as Record<string, Credential>;

    return new FileCredentialStore(path, data);
  }

  async read(providerId: string) {
    await this.queue;
    return this.credentials[providerId];
  }

  async list() {
    await this.queue;
    return Object.entries(this.credentials).map(
      ([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }),
    );
  }

  modify(
    providerId: string,
    fn: (
      current: Credential | undefined,
    ) => Promise<Credential | undefined>,
  ) {
    const operation = this.queue.then(async () => {
      const current = this.credentials[providerId];
      const updated = await fn(current);

      if (updated !== undefined) {
        const next = {
          ...this.credentials,
          [providerId]: updated,
        };

        await this.save(next);
        this.credentials = next;
      }

      return updated ?? current;
    });

    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );

    return operation;
  }

  delete(providerId: string) {
    const operation = this.queue.then(async () => {
      const next = { ...this.credentials };
      delete next[providerId];

      await this.save(next);
      this.credentials = next;
    });

    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );

    return operation;
  }

  private async save(data: Record<string, Credential>) {
    const temporary = `${this.path}.tmp`;

    await writeFile(
      temporary,
      JSON.stringify(data, null, 2),
      { mode: 0o600 },
    );

    await rename(temporary, this.path);
  }
}

// The ChatGPT sign-in in auth.json; the model and reasoning level come from OPENAI_MODEL and REASONING.
export async function openModel(modelId = process.env.OPENAI_MODEL ?? "gpt-6-sol") {
  const models = createModels({ credentials: await FileCredentialStore.open() });
  models.setProvider(openaiProvider());
  if (!(await models.getAuth("openai"))) throw new Error("ChatGPTでのログインが必要です");
  const model = models.getModel("openai", modelId) ?? (() => { throw new Error(`未対応のモデル: ${modelId}`); })();
  return { models, model, reasoning: (process.env.REASONING ?? "medium") as ThinkingLevel };
}
