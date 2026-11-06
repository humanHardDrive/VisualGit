// Prints the inferred branch tree for a repository:
//   npm run inspect -- /path/to/repo
import { loadRepo } from "../src/git/load.ts";
import { nodeRunner } from "../src/git/nodeRunner.ts";
import { inferModel } from "../src/model/infer.ts";
import { layoutModel } from "../src/model/layout.ts";

const repo = process.argv[2] ?? ".";
const t0 = performance.now();
const raw = await loadRepo(nodeRunner(repo));
const t1 = performance.now();
const model = inferModel(raw);
const layout = layoutModel(model);
const t2 = performance.now();

const short = (h: string | null) => (h ? h.slice(0, 7) : "-");
const print = (id: number, depth: number) => {
  const b = model.branches[id];
  const s = layout.spans[id];
  const info = [
    b.kind,
    `${b.commits.length} commits`,
    `base ${short(b.base)}`,
    `row ${s.row}`,
    b.createdFrom ? `created from ${b.createdFrom}` : "",
    b.isHead ? "HEAD" : "",
  ].filter(Boolean);
  console.log(`${"  ".repeat(depth)}${b.name}  (${info.join(", ")})`);
  for (const c of b.children) print(c, depth + 1);
};
for (const b of model.branches) if (b.parent === null) print(b.id, 0);

console.log(
  `\n${model.order.length} commits, ${model.branches.length} branches, ${layout.rows} rows` +
    `${model.truncated ? " (history truncated)" : ""}; git ${(t1 - t0).toFixed(0)}ms, model+layout ${(t2 - t1).toFixed(0)}ms`,
);
