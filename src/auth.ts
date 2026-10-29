
import { readFile, rename, writeFile } from "node:fs/promises";
import type {
  Credential,
  CredentialStore,
} from "@earendil-works/pi-ai";

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
