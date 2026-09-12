import { piTarget } from "./pi.js";
import { ompTarget } from "./omp.js";

export const TARGET_LIST = [piTarget, ompTarget];

export const targetFor = (id) => {
  const target = TARGET_LIST.find((t) => t.id === id);
  if (!target) throw new Error(`unknown target "${id}" (expected pi or omp)`);
  return target;
};
