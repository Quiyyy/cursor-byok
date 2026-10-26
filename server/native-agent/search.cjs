// Cursor owns approval and tool execution. Only select the search backend here.
const cancelled = (error, signal) => signal?.aborted || error?.name === 'AbortError' || [1, 10].includes(error?.code);
async function invoke(search, args) {
  const signal = args[0]?.signal;
  signal?.throwIfAborted();
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal?.addEventListener('abort', onAbort, {once:true});
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return search(...args);
    }), stopped]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
function prefer(official, provider) {
  if (!official) return provider;
  return async (...args) => {
    let failure;
    try {
      const result = await invoke(official, args);
      if (result?.answer?.trim() || (Array.isArray(result?.documents) && result.documents.length)) return result;
      throw new Error('Cursor WebSearch returned no answer or documents');
    } catch (error) {
      if (cancelled(error, args[0]?.signal)) throw error;
      failure = error;
    }
    console.warn('[Cursor BYOK] Official WebSearch unavailable; using provider search');
    try {
      return await invoke(provider, args);
    } catch (error) {
      if (cancelled(error, args[0]?.signal)) throw error;
      throw new AggregateError([failure, error], `Cursor WebSearch: ${failure?.message ?? String(failure)}; provider search: ${error?.message ?? String(error)}`);
    }
  };
}
exports.prefer = prefer;
