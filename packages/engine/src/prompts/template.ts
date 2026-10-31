/**
 * Minimal prompt templating (task T03-01).
 *
 * Supports exactly two tags:
 * - `{{name}}` inserts a variable.
 * - `{{#each list}}…{{/each}}` repeats a block per item. Inside it `{{this}}`
 *   is the item; for object items `{{field}}` reads the item first, then the
 *   outer variables.
 *
 * Values are inserted literally and never re-scanned, so a value containing
 * `{{x}}` stays as text. There are no expressions, helpers, partials, includes
 * or file access. Any other `{{…}}` is an error. Write `\{{` for a literal
 * `{{` (e.g. GitHub Actions `$\{{ github.sha }}`).
 *
 * Parsing is a single linear scan, so a hostile prompt cannot make it slow.
 */

export type TemplateValue =
  | string
  | number
  | boolean
  | readonly TemplateValue[]
  | { readonly [key: string]: TemplateValue };

export type TemplateVariables = Readonly<Record<string, TemplateValue | undefined>>;

export class TemplateError extends Error {
  constructor(
    message: string,
    /** Variables the template used that were not provided. */
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const VAR_TAG = new RegExp(`^\\s*(${NAME})\\s*$`);
const EACH_OPEN = new RegExp(`^\\s*#each\\s+(${NAME})\\s*$`);
const EACH_CLOSE = /^\s*\/each\s*$/;

type Node =
  | { kind: "text"; text: string }
  | { kind: "var"; name: string }
  | { kind: "each"; list: string; body: Node[] };

function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ list: string; body: Node[] }> = [];
  const current = (): Node[] => stack.at(-1)?.body ?? root;
  let text = "";
  const flushText = () => {
    if (text.length > 0) {
      current().push({ kind: "text", text });
      text = "";
    }
  };

  let pos = 0;
  while (pos < template.length) {
    const open = template.indexOf("{{", pos);
    if (open < 0) {
      text += template.slice(pos);
      break;
    }
    if (open > 0 && template[open - 1] === "\\") {
      // `\{{` is a literal `{{`; drop the backslash.
      text += `${template.slice(pos, open - 1)}{{`;
      pos = open + 2;
      continue;
    }
    text += template.slice(pos, open);
    const close = template.indexOf("}}", open + 2);
    if (close < 0) {
      throw new TemplateError("Unclosed {{ in template");
    }
    const inner = template.slice(open + 2, close);
    if (inner.includes("{{")) {
      throw new TemplateError("Unclosed {{ in template");
    }
    pos = close + 2;
    flushText();

    const eachOpen = EACH_OPEN.exec(inner);
    if (eachOpen) {
      stack.push({ list: eachOpen[1]!, body: [] });
      continue;
    }
    if (EACH_CLOSE.test(inner)) {
      const block = stack.pop();
      if (!block) {
        throw new TemplateError("Unexpected {{/each}} without a matching {{#each}}");
      }
      current().push({ kind: "each", list: block.list, body: block.body });
      continue;
    }
    const variable = VAR_TAG.exec(inner);
    if (variable) {
      current().push({ kind: "var", name: variable[1]! });
      continue;
    }
    throw new TemplateError(
      `Unsupported template tag {{${inner.slice(0, 40)}}}: only {{name}} and {{#each list}}…{{/each}} are allowed (write \\{{ for a literal {{)`,
    );
  }
  flushText();

  if (stack.length > 0) {
    throw new TemplateError(`Unclosed {{#each ${stack.at(-1)!.list}}}`);
  }
  return root;
}

/**
 * Variable names a template reads outside `{{#each}}` blocks, plus each block's
 * list name. Names used inside a block are not listed: they may be item fields
 * or outer variables, which only the data can tell apart.
 */
export function templateVariables(template: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: Node[], inEach: boolean) => {
    for (const node of nodes) {
      if (node.kind === "var" && !inEach && node.name !== "this") {
        names.add(node.name);
      } else if (node.kind === "each") {
        names.add(node.list);
        walk(node.body, true);
      }
    }
  };
  walk(parse(template), false);
  return [...names];
}

function formatValue(value: TemplateValue, name: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatValue(item, name)).join(", ");
  }
  throw new TemplateError(`Variable "${name}" is an object; use it inside {{#each}}`);
}

/**
 * Render `template` with `variables`. Throws `TemplateError` listing every
 * missing variable (in first-use order) when any is unset.
 */
export function renderPrompt(template: string, variables: TemplateVariables): string {
  const nodes = parse(template);
  const missing: string[] = [];
  const note = (name: string) => {
    if (!missing.includes(name)) {
      missing.push(name);
    }
  };

  const render = (list: Node[], scopes: TemplateVariables[]): string => {
    const lookup = (name: string): TemplateValue | undefined => {
      for (const scope of scopes) {
        if (Object.prototype.hasOwnProperty.call(scope, name) && scope[name] !== undefined) {
          return scope[name];
        }
      }
      return undefined;
    };

    let out = "";
    for (const node of list) {
      if (node.kind === "text") {
        out += node.text;
      } else if (node.kind === "var") {
        const value = lookup(node.name);
        if (value === undefined) {
          note(node.name);
        } else {
          out += formatValue(value, node.name);
        }
      } else {
        const value = lookup(node.list);
        if (value === undefined) {
          note(node.list);
          continue;
        }
        if (!Array.isArray(value)) {
          throw new TemplateError(`{{#each ${node.list}}} needs a list`);
        }
        for (const item of value as readonly TemplateValue[]) {
          // Null prototype: an item key like `__proto__` is just a key.
          const itemScope: Record<string, TemplateValue> = Object.create(null);
          if (item && typeof item === "object" && !Array.isArray(item)) {
            for (const [key, value] of Object.entries(item)) {
              itemScope[key] = value;
            }
          }
          itemScope.this = item;
          out += render(node.body, [itemScope, ...scopes]);
        }
      }
    }
    return out;
  };

  const text = render(nodes, [variables]);
  if (missing.length > 0) {
    throw new TemplateError(`Missing template variables: ${missing.join(", ")}`, missing);
  }
  return text;
}
