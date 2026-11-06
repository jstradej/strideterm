interface JiraRichNode {
  type?: string;
  text?: string;
  content?: unknown[];
  marks?: JiraRichNode[];
  attrs?: Record<string, unknown> & { level?: number; order?: number };
}

function nodeObject(value: unknown): JiraRichNode {
  return value && typeof value === "object" ? (value as JiraRichNode) : {};
}

/** Convert Jira's two rich-text formats to Markdown, never treating ADF text as markup. */
export function jiraDescriptionMarkdown(value: unknown): string {
  const limit = 32_000;
  let characters = 24_000;
  let nodes = 4_000;
  const take = (text: string) => {
    const part = text.slice(0, Math.max(0, characters));
    characters -= part.length;
    return part;
  };
  const visit = (depth: number) => depth <= 20 && characters > 0 && nodes-- > 0;
  // Escape every Markdown punctuation character that can start a construct.
  const literal = (text: string): string => text.replace(/[\\`*_{}[\]<>()#!+\-.|~&]/g, "\\$&");
  const codeSpan = (text: string): string => {
    if (!text) return "";
    const fence = "`".repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)));
    return `${fence} ${text.replace(/\n/g, " ")} ${fence}`;
  };
  const codeBlock = (text: string): string => {
    const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)));
    return `${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
  };
  const link = (label: string, destination: unknown): string => {
    if (typeof destination !== "string" || destination.length > 4096) return label;
    try {
      const url = new URL(destination);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return label;
      const href = url.href.replace(/[()<>\\\s|]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      return `[${label}](${href})`;
    } catch {
      return label;
    }
  };
  const table = (rows: string[][]): string => {
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (!width) return "";
    const line = (cells: string[]) =>
      `| ${Array.from({ length: width }, (_, i) => (cells[i] || "").replace(/(?<!\\)\|/g, "\\|")).join(" | ")} |`;
    return [line(rows[0]), line(Array<string>(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
  };
  const rawCode = (node: unknown, depth: number): string => {
    if (!visit(depth)) return "";
    if (typeof node === "string") return take(node);
    if (Array.isArray(node))
      return node
        .slice(0, 4000)
        .map((child) => rawCode(child, depth + 1))
        .join("");
    if (!node || typeof node !== "object") return "";
    const obj = nodeObject(node);
    if (typeof obj.text === "string") return take(obj.text);
    if (obj.type === "hardBreak") return take("\n");
    return rawCode(obj.content, depth + 1);
  };
  const render = (node: unknown, depth: number, block = true): string => {
    if (!visit(depth)) return "";
    if (typeof node === "string") return literal(take(node));
    if (Array.isArray(node)) {
      const children: unknown[] = node.slice(0, 4000);
      // ADF can split a single marked phrase into adjacent text nodes.
      // Merge identical marks before producing CommonMark delimiters.
      const merged: unknown[] = [];
      const signature = (child: JiraRichNode) =>
        Array.isArray(child.marks)
          ? child.marks
              .slice(0, 16)
              .map((mark: JiraRichNode) => `${mark?.type}:${String(mark?.attrs?.href || "").slice(0, 4096)}`)
              .join("|")
          : "";
      for (const child of children) {
        const previous = nodeObject(merged[merged.length - 1]);
        const current = nodeObject(child);
        if (
          !block &&
          typeof current.text === "string" &&
          typeof previous?.text === "string" &&
          signature(current) === signature(previous)
        ) {
          previous.text = (previous.text + current.text.slice(0, 24_000)).slice(0, 24_000);
        } else merged.push(child && typeof child === "object" ? { ...child } : child);
      }
      return merged
        .map((child) => render(child, depth + 1, block))
        .filter(Boolean)
        .join(block ? "\n\n" : "");
    }
    if (!node || typeof node !== "object") return "";
    const obj = nodeObject(node);
    const children: unknown[] = Array.isArray(obj.content) ? obj.content.slice(0, 4000) : [];
    if (typeof obj.text === "string") {
      const raw = take(obj.text);
      const marks = Array.isArray(obj.marks) ? obj.marks.slice(0, 16) : [];
      const [, leading, body, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw)!;
      if (!body) return literal(raw);
      let text = marks.some((mark) => mark?.type === "code") ? codeSpan(body) : literal(body);
      for (const mark of marks) {
        if (mark?.type === "strong") text = `**${text}**`;
        else if (mark?.type === "em") text = `*${text}*`;
        else if (mark?.type === "strike") text = `~~${text}~~`;
        else if (mark?.type === "link") text = link(text, mark.attrs?.href);
      }
      return literal(leading) + text + literal(trailing);
    }
    switch (obj.type) {
      case "doc":
        return render(children, depth + 1);
      case "hardBreak":
        return "  \n";
      case "paragraph":
        return render(children, depth + 1, false);
      case "heading": {
        const level =
          typeof obj.attrs?.level === "number" && Number.isInteger(obj.attrs.level)
            ? Math.max(1, Math.min(6, obj.attrs.level))
            : 1;
        return `${"#".repeat(level)} ${render(children, depth + 1, false)}`;
      }
      case "bulletList":
      case "orderedList": {
        const start =
          typeof obj.attrs?.order === "number" &&
          Number.isSafeInteger(obj.attrs.order) &&
          obj.attrs.order > 0 &&
          obj.attrs.order < 1_000_000
            ? obj.attrs.order
            : 1;
        return children
          .map((item, index) => {
            const marker = obj.type === "orderedList" ? `${start + index}. ` : "- ";
            const body = render(item, depth + 1);
            return marker + body.replace(/\n/g, `\n${" ".repeat(marker.length)}`);
          })
          .join("\n");
      }
      case "listItem":
        return render(children, depth + 1);
      case "blockquote":
        return render(children, depth + 1)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      case "codeBlock":
        return codeBlock(rawCode(children, depth + 1));
      case "rule":
        return "---";
      case "table":
        return table(
          children.slice(0, 100).map((row) => {
            const content = nodeObject(row).content;
            return (Array.isArray(content) ? content.slice(0, 50) : []).map((cell: unknown) =>
              render(cell, depth + 1).replace(/\n/g, " "),
            );
          }),
        );
      case "mention":
        return literal(take(String(obj.attrs?.text || "@user")));
      case "emoji":
        return literal(take(String(obj.attrs?.text || obj.attrs?.shortName || "")));
      case "inlineCard":
        return link(literal(take(String(obj.attrs?.url || "Link"))), obj.attrs?.url);
      case "media":
      case "mediaSingle":
      case "mediaGroup":
        return literal(take("[Attachment]"));
      default:
        return render(children, depth + 1, block);
    }
  };

  // Jira DC strings are wiki markup. Recognize its own syntax explicitly; HTML
  // descriptions continue through the existing plain-text normalization path.
  const wikiInline = (source: string, depth = 0): string => {
    if (depth > 8) return literal(source);
    // Emphasis counts only at a word edge, as in Jira, and a bare link is taken whole, so `snake_case` and
    // `?q=primary_user_set` keep their underscores.
    const pattern =
      /\{\{([^\n]*?)\}\}|\[([^\]\n]+)\]|!([^!\n]+)!|(?<![\p{L}\p{N}])\*([^*\n]+)\*(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])|(https?:\/\/[^\s<>"[\]{}|!]+)/gu;
    let out = "",
      cursor = 0;
    for (const match of source.matchAll(pattern)) {
      out += literal(source.slice(cursor, match.index));
      if (match[1] !== undefined) out += codeSpan(match[1]);
      else if (match[2] !== undefined) {
        const [label, href] = match[2].split("|", 2);
        out += label.startsWith("~")
          ? literal(`@${label.slice(1)}`)
          : href || /^https?:\/\//i.test(label)
            ? link(literal(label), href || label)
            : literal(match[0]);
      } else if (match[3] !== undefined) out += literal("[Attachment]");
      else if (match[4] !== undefined) out += `**${wikiInline(match[4], depth + 1)}**`;
      else if (match[5] !== undefined) out += `*${wikiInline(match[5], depth + 1)}*`;
      else if (match[6] !== undefined) {
        const url = match[6].replace(/[.,;:?)]+$/, "");
        out += link(literal(url), url) + literal(match[6].slice(url.length));
      }
      cursor = (match.index ?? 0) + match[0].length;
    }
    return out + literal(source.slice(cursor));
  };
  const wikiLines = (source: string): string => {
    const lines = source.split("\n"),
      output: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\|.*\|\s*$/.test(line)) {
        const rows: string[][] = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
          rows.push(
            lines[i]
              .trim()
              .replace(/^\|\|?|\|\|?$/g, "")
              .split(/\|\|?/)
              .map((cell) => wikiInline(cell.trim())),
          );
          i++;
        }
        i--;
        output.push(table(rows), "");
        continue;
      }
      const heading = /^h([1-6])\.\s+(.*)$/.exec(line);
      const list = /^([*#]+)\s+(.*)$/.exec(line);
      if (heading) output.push(`${"#".repeat(Number(heading[1]))} ${wikiInline(heading[2])}`);
      else if (list)
        output.push(
          `${"   ".repeat(Math.min(20, list[1].length - 1))}${list[1].endsWith("#") ? "1." : "-"} ${wikiInline(list[2])}`,
        );
      else if (line.startsWith("bq. ")) output.push(`> ${wikiInline(line.slice(4))}`);
      else output.push(wikiInline(line));
    }
    return output.join("\n");
  };
  let output: string;
  if (typeof value === "string") {
    const source = take(value).replace(/\r\n?/g, "\n");
    // These block macro bodies are scanned separately, so code remains literal.
    // Closing code/panel macros omit opening attributes.
    // eslint-disable-next-line security/detect-unsafe-regex -- source is capped at 24,000 characters above; delimiters bound each opening token.
    const blocks = /\{(code|noformat|quote|panel)(?::([^}\n]*))?\}([\s\S]*?)\{\1\}/gi;
    if (
      !/(?:^h[1-6]\.\s|^[*#]+\s|^bq\.\s|^\|.*\||\{(?:code|noformat|quote|panel)[}:]|\[[^\]\n]+\|[^\]\n]+\]|\[https?:\/\/[^\]\n]+\]|\*[^*\n]+\*|_[^_\n]+_|\{\{)/m.test(
        source,
      )
    )
      return "";
    const chunks: string[] = [];
    let cursor = 0;
    for (const match of source.matchAll(blocks)) {
      const prose = source.slice(cursor, match.index);
      if (/<\/?[a-z][^>]*>/i.test(prose)) return "";
      chunks.push(wikiLines(prose));
      if (/^(code|noformat)$/i.test(match[1])) chunks.push(codeBlock(match[3]));
      else if (match[1].toLowerCase() === "quote")
        chunks.push(
          wikiLines(match[3])
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        );
      else {
        const title = /(?:^|\|)title=([^|]*)/i.exec(match[2] || "")?.[1];
        chunks.push([title ? `**${wikiInline(title)}**` : "", wikiLines(match[3])].filter(Boolean).join("\n\n"));
      }
      cursor = (match.index ?? 0) + match[0].length;
    }
    if (/<\/?[a-z][^>]*>/i.test(source.slice(cursor))) return "";
    chunks.push(wikiLines(source.slice(cursor)));
    output = chunks.filter(Boolean).join("\n\n").trim();
  } else output = render(value, 0).trim();
  // Reject oversized output instead of cutting through a code fence or escape.
  // The caller retains the independently bounded plain-text fallback.
  return output.length <= limit ? output : "";
}
