// Global test setup. Add fixtures or env shims here as needed.
Object.defineProperty(process.env, 'NODE_ENV', {
  value: 'test',
  writable: true,
});
