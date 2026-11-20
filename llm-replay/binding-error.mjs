export class BindingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BindingError';
    this.code = code;
    this.details = details;
  }
}
