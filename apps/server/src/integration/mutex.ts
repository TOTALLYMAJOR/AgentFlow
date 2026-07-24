export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  public async runExclusive<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.#tails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => gate);
    this.#tails.set(key, tail);

    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }

  public isLocked(key: string): boolean {
    return this.#tails.has(key);
  }
}

export const processIntegrationMutex = new KeyedMutex();
