export function createClassList() {
  const values = new Set();
  return {
    contains: (name) => values.has(name),
    toggle: (name, enabled) => {
      if (enabled) values.add(name);
      else values.delete(name);
    }
  };
}
