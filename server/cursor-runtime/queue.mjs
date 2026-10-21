// A cancellable stream used for model arguments and Cursor Exec responses.
export class AsyncQueue {
  #values = [];
  #waiters = [];
  #closed = false;
  #error;
  push(value) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({
      value,
      done: false
    });else this.#values.push(value);
  }
  close(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);else waiter.resolve({
        done: true
      });
    }
  }
  next() {
    if (this.#values.length) return Promise.resolve({
      value: this.#values.shift(),
      done: false
    });
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({
      done: true
    });
    return new Promise((resolve, reject) => this.#waiters.push({
      resolve,
      reject
    }));
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}
