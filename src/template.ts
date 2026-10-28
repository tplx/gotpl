/**
 * Go-style template engine for browsers.
 * Supported subset: {% .Field %}, if/else, range/else, with/else,
 * define/template, variables (:= and =), pipelines, and common functions.
 */
export type TemplateData = unknown;

type Scope = { vars: Map<string, unknown>; dot: unknown };

class SafeHTML { 
  constructor(public readonly value: string) {} 
}

type Node =
  | { type: "text"; value: string }
  | { type: "action"; expr: string }
  | { type: "if"; expr: string; yes: Node[]; no: Node[] }
  | { type: "range"; expr: string; vars: string[]; body: Node[]; otherwise: Node[] }
  | { type: "with"; expr: string; body: Node[]; otherwise: Node[] }
  | { type: "assign"; name: string; expr: string; declare: boolean }
  | { type: "template"; name: string; expr?: string }
  | { type: "define"; name: string; body: Node[] };

type ParseResult = { nodes: Node[]; stop?: string };

const TOKEN_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\$[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\$(?:\.[A-Za-z_]\w*)*|\.?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+(?:\.\d+)?|==|!=|>=|<=|[()|,=<>]/g;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export { GoTpl as New };

const noEndPrefix="Missing {% end %} for ";

export class GoTpl {
  private templates = new Map<string, Node[]>();
  private funcs: Record<string, (...args: unknown[]) => unknown>;

  constructor(extraFuncs: Record<string, (...args: unknown[]) => unknown> = {}) {
    this.funcs = { ...defaultFuncs, ...extraFuncs };
  }

  /** Render a source string. Named templates declared with define are registered for this render. */
  render(source: string, data: unknown = {}): string {
    this.templates = new Map();
    const parsed = this.parse(source);
    this.collectDefinitions(parsed);
    const vars = new Map<string, unknown>();
    vars.set("$", data);
    return this.renderNodes(parsed, { dot: data, vars }, 0);
  }

  /** Read an HTML <template> element and render its contents. */
  renderElement(element: HTMLTemplateElement | string, data: unknown = {}): string {
    const el = typeof element === "string"
      ? document.querySelector<HTMLTemplateElement>(element)
      : element;
    if (!el) throw new TemplateError(`Template element not found: ${String(element)}`);
    if (!(el instanceof HTMLTemplateElement)) {
      throw new TemplateError("The selected element must be an HTMLTemplateElement.");
    }
    return this.render(el.innerHTML, data);
  }

  /** Render and insert output into a target element. */
  renderTo(target: Element | string, template: HTMLTemplateElement | string, data: unknown = {}): string {
    const el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) throw new TemplateError(`Render target not found: ${String(target)}`);
    const html = this.renderElement(template, data);
    el.innerHTML = html;
    return html;
  }

  private parse(source: string): Node[] {
    const tokens = source.split(/({%[\s\S]*?%})/g).filter(x => x !== "");
    const parseBlock = (start: number, stops: string[]): ParseResult & { index: number } => {
      const nodes: Node[] = [];
      let i = start;
      while (i < tokens.length) {
        const token = tokens[i++];
        if (!token.startsWith("{%") || !token.endsWith("%}")) {
          nodes.push({ type: "text", value: token });
          continue;
        }
        let cmd = token.slice(2, -2).trim();
        if (cmd.startsWith("/*") && cmd.endsWith("*/")) continue;
        if (stops.some(s => cmd === s || cmd.startsWith(s + " "))) {
          return { nodes, stop: cmd, index: i };
        }
        if (cmd.startsWith("if ")) {
          const expr = cmd.slice(3).trim();
          const yesResult = parseBlock(i, ["else", "end"]);
          i = yesResult.index;
          let no: Node[] = [];
          if (yesResult.stop?.startsWith("else if ")) {
            const nestedIf = parseElseIf(yesResult.stop.slice(8).trim(), i);
            no = [nestedIf.node];
            i = nestedIf.index;
          } else if (yesResult.stop === "else") {
            const noResult = parseBlock(i, ["end"]);
            no = noResult.nodes;
            i = noResult.index;
            if (noResult.stop !== "end") throw new TemplateError(noEndPrefix+"{% if %}");
          } else if (yesResult.stop !== "end") {
            throw new TemplateError(noEndPrefix+"{% if %}");
          }
          nodes.push({ type: "if", expr, yes: yesResult.nodes, no });
          continue;
        }
        if (cmd.startsWith("range ")) {
          let rest = cmd.slice(6).trim();
          const vars: string[] = [];
          const assign = rest.match(/^(\$[\w]+(?:\s*,\s*\$[\w]+)?)\s*:=\s*([\s\S]+)$/);
          if (assign) {
            vars.push(...assign[1].split(",").map(s => s.trim()));
            rest = assign[2].trim();
          }
          const bodyResult = parseBlock(i, ["else", "end"]);
          i = bodyResult.index;
          let otherwise: Node[] = [];
          if (bodyResult.stop === "else") {
            const elseResult = parseBlock(i, ["end"]);
            otherwise = elseResult.nodes;
            i = elseResult.index;
            if (elseResult.stop !== "end") throw new TemplateError(noEndPrefix+"{% range %}");
          } else if (bodyResult.stop !== "end") {
            throw new TemplateError(noEndPrefix+"{% range %}");
          }
          nodes.push({ type: "range", expr: rest, vars, body: bodyResult.nodes, otherwise });
          continue;
        }
        if (cmd.startsWith("with ")) {
          const expr = cmd.slice(5).trim();
          const bodyResult = parseBlock(i, ["else", "end"]);
          i = bodyResult.index;
          let otherwise: Node[] = [];
          if (bodyResult.stop === "else") {
            const elseResult = parseBlock(i, ["end"]);
            otherwise = elseResult.nodes;
            i = elseResult.index;
            if (elseResult.stop !== "end") throw new TemplateError(noEndPrefix+"{% with %}");
          } else if (bodyResult.stop !== "end") {
            throw new TemplateError(noEndPrefix+"{% with %}");
          }
          nodes.push({ type: "with", expr, body: bodyResult.nodes, otherwise });
          continue;
        }
        if (cmd.startsWith("define ")) {
          const name = readQuotedName(cmd.slice(7).trim());
          const bodyResult = parseBlock(i, ["end"]);
          i = bodyResult.index;
          if (bodyResult.stop !== "end") throw new TemplateError(noEndPrefix+`{% define "${name}" %}`);
          nodes.push({ type: "define", name, body: bodyResult.nodes });
          continue;
        }
        if (cmd.startsWith("template ")) {
          const rest = cmd.slice(9).trim();
          const m = rest.match(/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(?:\s+([\s\S]+))?$/);
          if (!m) throw new TemplateError(`Invalid template invocation: ${cmd}`);
          nodes.push({ type: "template", name: String(unquote(m[1])), expr: m[2]?.trim() });
          continue;
        }
        if (cmd === "else" || cmd === "end") {
          throw new TemplateError(`Unexpected {% ${cmd} %}`);
        }
        const declaration = cmd.match(/^(\$[\w]+)\s*(:=|=)\s*([\s\S]+)$/);
        if (declaration) {
          nodes.push({
            type: "assign",
            name: declaration[1],
            declare: declaration[2] === ":=",
            expr: declaration[3].trim()
          });
          continue;
        }
        if (cmd.startsWith("$") && !cmd.includes(" ")) {
          nodes.push({ type: "action", expr: cmd });
          continue;
        }
        nodes.push({ type: "action", expr: cmd });
      }
      return { nodes, index: i };
    };
    const parseElseIf = (condition: string, start: number): { node: Node; index: number } => {
      const yesResult = parseBlock(start, ["else", "end"]);
      let no: Node[] = [];
      let index = yesResult.index;
      if (yesResult.stop?.startsWith("else if ")) {
        const nested = parseElseIf(yesResult.stop.slice(8).trim(), index);
        no = [nested.node];
        index = nested.index;
      } else if (yesResult.stop === "else") {
        const elseResult = parseBlock(index, ["end"]);
        no = elseResult.nodes;
        index = elseResult.index;
        if (elseResult.stop !== "end") {
          throw new TemplateError(noEndPrefix+"{% else if %}");
        }
      } else if (yesResult.stop !== "end") {
          throw new TemplateError(noEndPrefix+"{% else if %}");
      }
      return { node: { type: "if", expr: condition, yes: yesResult.nodes, no }, index };
    };
    return parseBlock(0, []).nodes;
  }

  private collectDefinitions(nodes: Node[]): void {
    for (const node of nodes) {
      if (node.type === "define") this.templates.set(node.name, node.body);
      if (node.type === "if") { this.collectDefinitions(node.yes); this.collectDefinitions(node.no); }
      if (node.type === "range") { this.collectDefinitions(node.body); this.collectDefinitions(node.otherwise); }
      if (node.type === "with") { this.collectDefinitions(node.body); this.collectDefinitions(node.otherwise); }
    }
  }

  private renderNodes(nodes: Node[], scope: Scope, depth: number): string {
    if (depth > 100) throw new TemplateError("Template recursion limit exceeded.");
    let out = "";
    for (const node of nodes) {
      switch (node.type) {
        case "text": out += node.value; break;
        case "action": {
          const value = this.evaluatePipeline(node.expr, scope);
          out += value == null ? "" : value instanceof SafeHTML ? value.value : escapeHtml(stringify(value));
          break;
        }
        case "assign": {
          const value = this.evaluatePipeline(node.expr, scope);
          if (node.declare || !scope.vars.has(node.name)) scope.vars.set(node.name, value);
          else scope.vars.set(node.name, value);
          break;
        }
        case "if": {
          const value = this.evaluatePipeline(node.expr, scope);
          out += this.renderNodes(truthy(value) ? node.yes : node.no, childScope(scope), depth + 1);
          break;
        }
        case "with": {
          const value = this.evaluatePipeline(node.expr, scope);
          if (truthy(value)) out += this.renderNodes(node.body, { dot: value, vars: new Map(scope.vars) }, depth + 1);
          else out += this.renderNodes(node.otherwise, childScope(scope), depth + 1);
          break;
        }
        case "range": {
          const value = this.evaluatePipeline(node.expr, scope);
          const entries = iterableEntries(value);
          if (!entries.length) {
            out += this.renderNodes(node.otherwise, childScope(scope), depth + 1);
            break;
          }
          entries.forEach(([key, item], index) => {
            const vars = new Map(scope.vars);
            if (node.vars.length === 1) vars.set(node.vars[0], item);
            if (node.vars.length >= 2) {
              vars.set(node.vars[0], key);
              vars.set(node.vars[1], item);
            }
            vars.set("$index", index);
            out += this.renderNodes(node.body, { dot: item, vars }, depth + 1);
          });
          break;
        }
        case "define": break;
        case "template": {
          const body = this.templates.get(node.name);
          if (!body) throw new TemplateError(`Template not defined: ${node.name}`);
          const dot = node.expr ? this.evaluatePipeline(node.expr, scope) : scope.dot;
          out += this.renderNodes(body, { dot, vars: new Map(scope.vars) }, depth + 1);
          break;
        }
      }
    }
    return out;
  }

  private evaluatePipeline(source: string, scope: Scope): unknown {
    const stages = splitOutside(source, "|");
    let value = this.evaluateExpression(stages[0].trim(), scope);
    for (const stage of stages.slice(1)) {
      const tokens = tokenize(stage.trim());
      if (!tokens.length) continue;
      const name = tokens.shift()!;
      const fn = this.funcs[name];
      if (!fn) throw new TemplateError(`Unknown function: ${name}`);
      const args = tokens.map(t => this.evaluateExpression(t, scope));
      value = fn(...args, value);
    }
    return value;
  }

  private evaluateExpression(source: string, scope: Scope): unknown {
    const tokens = tokenize(source);
    if (!tokens.length) return "";
    let pos = 0;
    const parseAtom = (): unknown => {
      const token = tokens[pos++];
      if (token === undefined) return "";
      if (token === "(") {
        const value = parseCallOrValue();
        if (tokens[pos] === ")") pos++;
        return value;
      }
      if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) return unquote(token);
      if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
      if (token === "true") return true;
      if (token === "false") return false;
      if (token === "nil" || token === "null") return null;
      if (token === ".") return scope.dot;
      if (token.startsWith("$")) {
        const [variable, ...path] = token.split(".");
        if (variable === "$") return path.length ? resolvePath(scope.vars.get("$"), path.join(".")) : scope.vars.get("$");
        if (!scope.vars.has(variable)) throw new TemplateError(`Undefined variable: ${variable}`);
        return path.length ? resolvePath(scope.vars.get(variable), path.join(".")) : scope.vars.get(variable);
      }
      if (token.startsWith(".")) return resolvePath(scope.dot, token.slice(1));
      if (Object.prototype.hasOwnProperty.call(this.funcs, token)) {
        const fn = this.funcs[token];
        const args: unknown[] = [];
        while (pos < tokens.length && tokens[pos] !== ")" && tokens[pos] !== "|") {
          args.push(parseAtom());
        }
        return fn(...args);
      }
      return token;
    };
    const parseCallOrValue = (): unknown => {
      if (tokens[pos] && Object.prototype.hasOwnProperty.call(this.funcs, tokens[pos])) return parseAtom();
      return parseAtom();
    };
    const result = parseCallOrValue();
    if (pos < tokens.length) {
      // Support simple infix comparisons: .A == .B, .A != .B, .N > 2, etc.
      const op = tokens[pos++];
      const right = parseAtom();
      switch (op) {
        case "==": return equal(result, right);
        case "!=": return !equal(result, right);
        case ">": return Number(result) > Number(right);
        case "<": return Number(result) < Number(right);
        case ">=": return Number(result) >= Number(right);
        case "<=": return Number(result) <= Number(right);
        default: throw new TemplateError(`Unexpected expression token: ${op}`);
      }
    }
    return result;
  }
}

function childScope(scope: Scope): Scope {
  return { dot: scope.dot, vars: new Map(scope.vars) };
}
function tokenize(source: string): string[] {
  const result = source.match(TOKEN_RE) ?? [];
  const compact = result.join("");
  if (compact !== source.replace(/\s+/g, "")) {
    // Operators such as > and < are accepted even though not all are in TOKEN_RE.
    const fallback = source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\$[\w]+(?:\.[A-Za-z_]\w*)*|\$(?:\.[A-Za-z_]\w*)*|\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\.|[A-Za-z_]\w*|\d+(?:\.\d+)?|==|!=|>=|<=|[()|,=<>]/g);
    return fallback ?? [];
  }
  return result;
}
function splitOutside(source: string, delimiter: string): string[] {
  const parts: string[] = [];
  let quote = "";
  let escaped = false;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === delimiter && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}
function resolvePath(root: unknown, path: string): unknown {
  if (!path) return root;
  let value: any = root;
  for (const key of path.split(".")) {
    if (value == null) return undefined;
    if (Array.isArray(value) && /^\d+$/.test(key)) value = value[Number(key)];
    else if (typeof value === "object" || typeof value === "string") value = (value as any)[key];
    else return undefined;
  }
  return value;
}
function iterableEntries(value: unknown): [unknown, unknown][] {
  if (Array.isArray(value)) return value.map((v, i) => [i, v]);
  if (typeof value === "string") return [...value].map((v, i) => [i, v]);
  if (value && typeof value === "object") return Object.keys(value as object).sort().map(k => [k, (value as any)[k]]);
  return [];
}
function truthy(value: unknown): boolean {
  if (value == null || value === false || value === "" || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}
function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return Array.isArray(value) ? value.map(stringify).join(" ") : "[object Object]";
  return String(value);
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;"
  })[c]!);
}
function unquote(token: string): string {
  if (token.startsWith("`")) return token.slice(1, -1);
  if (token.startsWith("'")) return token.slice(1, -1).replace(/\\'/g, "'");
  try { return JSON.parse(token); } catch { return token.slice(1, -1); }
}
function readQuotedName(token: string): string {
  if (!(token.startsWith('"') || token.startsWith("'"))) throw new TemplateError("Template name must be quoted.");
  return String(unquote(token));
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  return String(a) === String(b);
}

const defaultFuncs: Record<string, (...args: unknown[]) => unknown> = {
  eq: (...a) => a.slice(1).every(v => equal(a[0], v)),
  ne: (a, b) => !equal(a, b),
  not: a => !truthy(a),
  and: (...a) => a.find(v => !truthy(v)) ?? a[a.length - 1],
  or: (...a) => a.find(truthy) ?? a[a.length - 1],
  len: a => (typeof a === "string" || Array.isArray(a)) ? a.length : (a && typeof a === "object" ? Object.keys(a).length : 0),
  index: (a, key) => (a as any)?.[key as any],
  print: (...a) => a.map(stringify).join(" "),
  printf: (format, ...args) => {
    let i = 0;
    return String(format).replace(/%(?:\.(\d+))?([vdsqf])/g, (_match, precision: string | undefined, verb: string) => {
      const v = args[i++];
      if (verb === "q") return JSON.stringify(stringify(v));
      if (verb === "d") return String(Number(v) | 0);
      if (verb === "f") return Number(v).toFixed(precision === undefined ? 6 : Math.min(100, Number(precision)));
      return stringify(v);
    });
  },
  upper: a => stringify(a).toUpperCase(),
  lower: a => stringify(a).toLowerCase(),
  title: a => stringify(a).replace(/\b\w/g, c => c.toUpperCase()),
  trim: a => stringify(a).trim(),
  trimSpace: a => stringify(a).trim(),
  contains: (a, b) => stringify(a).includes(stringify(b)),
  hasPrefix: (a, b) => stringify(a).startsWith(stringify(b)),
  hasSuffix: (a, b) => stringify(a).endsWith(stringify(b)),
  replace: (a, oldValue, newValue) => stringify(a).split(stringify(oldValue)).join(stringify(newValue)),
  add: (a, b) => typeof a === "number" && typeof b === "number" ? a + b : stringify(a) + stringify(b),
  sub: (a, b) => Number(a) - Number(b),
  mul: (a, b) => Number(a) * Number(b),
  div: (a, b) => Number(a) / Number(b),
  mod: (a, b) => Number(a) % Number(b),
  default: (fallback, value) => truthy(value) ? value : fallback,
  json: a => JSON.stringify(a),
  html: a => new SafeHTML(stringify(a)), // Explicit raw HTML output: use only with trusted content.
  urlquery: a => encodeURIComponent(stringify(a)),
};
