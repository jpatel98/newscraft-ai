type ToolGuardOptions = {
  timeoutMs?: number;
  retries?: number;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function runWithToolGuard<T>(
  toolName: string,
  execute: () => Promise<T>,
  options?: ToolGuardOptions,
): Promise<
  | { ok: true; result: T; meta: { tool: string; attempts: number } }
  | { ok: false; error: string; meta: { tool: string; attempts: number } }
> {
  const retries = options?.retries ?? 1;
  const timeoutMs = options?.timeoutMs ?? 15_000;
  let attempts = 0;
  let lastError = "Unknown tool failure.";

  while (attempts <= retries) {
    attempts += 1;
    try {
      const result = await withTimeout(execute(), timeoutMs);
      return {
        ok: true,
        result,
        meta: { tool: toolName, attempts },
      };
    } catch (error) {
      lastError =
        error instanceof Error ? error.message : "Unknown tool failure.";
    }
  }

  return {
    ok: false,
    error: lastError,
    meta: { tool: toolName, attempts },
  };
}
