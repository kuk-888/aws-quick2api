/**
 * Streaming sanitizer for AWS Quick's proprietary interactive UI XML tags
 * (`<decision>`, `<decisions>`, `<artifact>`) that third-party OpenAI/Anthropic
 * clients cannot render natively.
 *
 * Converts them cleanly into standard Markdown while:
 * - Preserving 0-latency streaming for normal text
 * - Never touching tags inside Markdown fenced code blocks (``` or ~~~)
 * - Gracefully flushing incomplete tags at end-of-stream or above a safety buffer cap
 */

const MAX_TAG_BUFFER_CHARS = 32_768;
const TAG_PREFIXES = ["<decisions", "<decision", "<artifact"] as const;

function decodeBasicXmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseXmlAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  const re = /([a-zA-Z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    const key = m[1]!.toLowerCase();
    const val = decodeBasicXmlEntities(m[2] ?? m[3] ?? "");
    attrs[key] = val;
  }
  return attrs;
}

function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function renderSingleDecision(attrText: string, innerXml: string): string {
  const attrs = parseXmlAttrs(attrText);
  const question = (attrs.question || "").trim();
  const isMulti = String(attrs.multi || "").toLowerCase() === "true";

  const options: Array<{ label: string; description: string }> = [];
  const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = optRe.exec(innerXml)) !== null) {
    const oAttrs = parseXmlAttrs(m[1] || "");
    const label = decodeBasicXmlEntities((m[2] || "").replace(/\s+/g, " ").trim());
    const description = (oAttrs.description || "").replace(/\s+/g, " ").trim();
    if (label || description) {
      options.push({ label: label || description, description: label ? description : "" });
    }
  }

  if (!question && options.length === 0) return "";

  const cjk = hasCjk(question) || options.some((o) => hasCjk(o.label) || hasCjk(o.description));
  const lines: string[] = [];
  if (question) {
    const alreadyAnnotated = /(可多选|多选|multi-?select)/i.test(question);
    const multiSuffix = isMulti && !alreadyAnnotated ? (cjk ? "（可多选）" : " (multi-select)") : "";
    lines.push(`**${question}**${multiSuffix}`);
  }
  for (const opt of options) {
    if (opt.description && opt.description !== opt.label) {
      lines.push(`- **${opt.label}** — ${opt.description}`);
    } else {
      lines.push(`- **${opt.label}**`);
    }
  }
  return `\n${lines.join("\n")}\n`;
}

function renderDecisionsBlock(innerXml: string): string {
  const rendered: string[] = [];
  const re = /<decision\b([^>]*)>([\s\S]*?)(?:<\/decision>|<\/invoke>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(innerXml)) !== null) {
    const block = renderSingleDecision(m[1] || "", m[2] || "").trim();
    if (block) rendered.push(block);
  }
  if (rendered.length === 0) return "";
  return `\n${rendered.join("\n\n")}\n`;
}

function renderArtifactBlock(attrText: string, innerBody: string | null): string {
  const attrs = parseXmlAttrs(attrText);
  const type = (attrs.type || "").toLowerCase();
  const title = (attrs.title || attrs.caption || "").trim();
  const src = (attrs.src || "").trim();

  if (type === "image" && src) {
    return `\n![${title || "image"}](${src})\n`;
  }
  const body = (innerBody || "").trim();
  if (body) {
    return title ? `\n**${title}**\n\n${body}\n` : `\n${body}\n`;
  }
  if (title) {
    return `\n> ${title}\n`;
  }
  return "";
}

/**
 * Checks if `tail` ends with a partial opening prefix of any watched tag (e.g. `<`, `<d`, `<dec`, `<art`).
 * Returns the index in `tail` where that potential prefix starts, or -1 if none.
 */
function findTrailingTagPrefixStart(text: string): number {
  const lower = text.toLowerCase();
  const maxCheck = Math.min(lower.length, 11); // longest prefix is "<decisions" (10 chars)
  for (let len = maxCheck; len >= 1; len--) {
    const slice = lower.slice(lower.length - len);
    if (!slice.startsWith("<")) continue;
    for (const prefix of TAG_PREFIXES) {
      if (prefix.startsWith(slice)) {
        return lower.length - len;
      }
    }
  }
  return -1;
}

export class StreamingUiTagSanitizer {
  private buf = "";
  private inFence = false;
  private fenceChar = "";
  private atLineStart = true;

  private advanceNormalText(text: string): string {
    // Update fenced-code-block state line-by-line while returning the exact text.
    let i = 0;
    while (i < text.length) {
      if (this.atLineStart) {
        let j = i;
        while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
        if (text.startsWith("```", j) || text.startsWith("~~~", j)) {
          const ch = text[j]!;
          if (!this.inFence) {
            this.inFence = true;
            this.fenceChar = ch;
          } else if (this.fenceChar === ch) {
            this.inFence = false;
            this.fenceChar = "";
          }
        }
      }
      const nl = text.indexOf("\n", i);
      if (nl === -1) {
        this.atLineStart = false;
        break;
      }
      this.atLineStart = true;
      i = nl + 1;
    }
    return text;
  }

  feed(chunk: string): string {
    if (!chunk) return "";
    this.buf += chunk;
    let out = "";

    while (this.buf.length > 0) {
      // If inside a Markdown fenced code block, pass through up to the next newline
      // (keeping only a tiny tail if the current line could be a closing fence).
      if (this.inFence) {
        const nl = this.buf.indexOf("\n");
        if (nl === -1) {
          // Wait for newline only if this line might close the fence
          if (/^[ \t]*[`~]{0,3}$/.test(this.buf)) break;
          out += this.advanceNormalText(this.buf);
          this.buf = "";
          break;
        }
        const line = this.buf.slice(0, nl + 1);
        this.buf = this.buf.slice(nl + 1);
        out += this.advanceNormalText(line);
        continue;
      }

      // Check if the buffer starts with a fence delimiter on a fresh line
      if (this.atLineStart) {
        if (/^[ \t]*[`~]{1,2}$/.test(this.buf)) {
          // Could be start of ``` or ~~~; wait for more chars
          break;
        }
        const fenceMatch = /^[ \t]*(?:```|~~~)/.exec(this.buf);
        if (fenceMatch) {
          const nl = this.buf.indexOf("\n");
          if (nl === -1) {
            // Still on opening fence line; flush and enter fence mode
            out += this.advanceNormalText(this.buf);
            this.buf = "";
            break;
          }
          const line = this.buf.slice(0, nl + 1);
          this.buf = this.buf.slice(nl + 1);
          out += this.advanceNormalText(line);
          continue;
        }
      }

      // Look for the earliest watched tag opening in the buffer
      const lower = this.buf.toLowerCase();
      let matchIdx = -1;
      let matchKind: "decisions" | "decision" | "artifact" | null = null;

      const candidates: Array<{ idx: number; kind: "decisions" | "decision" | "artifact" }> = [];
      const reDecisions = /<decisions(?:\s|>)/i.exec(lower);
      if (reDecisions) candidates.push({ idx: reDecisions.index, kind: "decisions" });
      const reDecision = /<decision(?:\s|>)/i.exec(lower);
      if (reDecision) candidates.push({ idx: reDecision.index, kind: "decision" });
      const reArtifact = /<artifact\s/i.exec(lower);
      if (reArtifact) candidates.push({ idx: reArtifact.index, kind: "artifact" });

      // Also check if a fenced code block starts BEFORE the earliest tag!
      const fenceLineMatch = /(?:^|\n)[ \t]*(?:```|~~~)/.exec(this.buf);
      const fenceStartIdx = fenceLineMatch
        ? fenceLineMatch.index + (fenceLineMatch[0].startsWith("\n") ? 1 : 0)
        : -1;

      if (candidates.length > 0) {
        candidates.sort((a, b) => a.idx - b.idx);
        matchIdx = candidates[0]!.idx;
        matchKind = candidates[0]!.kind;
      }

      if (fenceStartIdx !== -1 && (matchIdx === -1 || fenceStartIdx < matchIdx)) {
        // Flush everything up to the fence line so the next iteration enters fence mode cleanly
        if (fenceStartIdx > 0) {
          out += this.advanceNormalText(this.buf.slice(0, fenceStartIdx));
          this.buf = this.buf.slice(fenceStartIdx);
          continue;
        }
      }

      if (matchIdx === -1) {
        // No complete opening tag found; check for trailing partial tag prefix or trailing fence start
        const partialIdx = findTrailingTagPrefixStart(this.buf);
        const nlLast = this.buf.lastIndexOf("\n");
        const tailAfterNl = nlLast === -1 ? this.buf : this.buf.slice(nlLast + 1);
        const partialFenceIdx =
          /^[ \t]*[`~]{1,2}$/.test(tailAfterNl) ||
            ((nlLast !== -1 || this.atLineStart) && /^[ \t]+$/.test(tailAfterNl))
            ? (nlLast === -1 ? 0 : nlLast + 1)
            : -1;

        let holdIdx = -1;
        if (partialIdx !== -1 && partialFenceIdx !== -1) holdIdx = Math.min(partialIdx, partialFenceIdx);
        else if (partialIdx !== -1) holdIdx = partialIdx;
        else if (partialFenceIdx !== -1) holdIdx = partialFenceIdx;

        if (holdIdx === -1) {
          out += this.advanceNormalText(this.buf);
          this.buf = "";
        } else if (holdIdx > 0) {
          out += this.advanceNormalText(this.buf.slice(0, holdIdx));
          this.buf = this.buf.slice(holdIdx);
        }
        break;
      }

      // Emit normal text preceding the tag
      if (matchIdx > 0) {
        out += this.advanceNormalText(this.buf.slice(0, matchIdx));
        this.buf = this.buf.slice(matchIdx);
        continue;
      }

      // Now this.buf starts right at the watched tag! Wait for its closing tag.
      // Attribute pattern skips `>` inside quoted values (e.g. title="A -> B").
      if (matchKind === "decisions") {
        const m = /^<decisions\b(?:"[^"]*"|'[^']*'|[^>"'])*>([\s\S]*?)<\/decisions>/i.exec(this.buf);
        if (!m) {
          if (this.buf.length > MAX_TAG_BUFFER_CHARS) {
            out += this.advanceNormalText(this.buf);
            this.buf = "";
          }
          break;
        }
        out += this.advanceNormalText(renderDecisionsBlock(m[1] || ""));
        this.buf = this.buf.slice(m[0].length);
        continue;
      }

      if (matchKind === "decision") {
        const m = /^<decision\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)(?:<\/decision>|<\/invoke>)/i.exec(this.buf);
        if (!m) {
          if (this.buf.length > MAX_TAG_BUFFER_CHARS) {
            out += this.advanceNormalText(this.buf);
            this.buf = "";
          }
          break;
        }
        out += this.advanceNormalText(renderSingleDecision(m[1] || "", m[2] || ""));
        this.buf = this.buf.slice(m[0].length);
        continue;
      }

      if (matchKind === "artifact") {
        const selfClose = /^<artifact\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/>/i.exec(this.buf);
        if (selfClose) {
          out += this.advanceNormalText(renderArtifactBlock(selfClose[1] || "", null));
          this.buf = this.buf.slice(selfClose[0].length);
          continue;
        }
        const paired = /^<artifact\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/artifact>/i.exec(this.buf);
        if (paired) {
          out += this.advanceNormalText(renderArtifactBlock(paired[1] || "", paired[2] || ""));
          this.buf = this.buf.slice(paired[0].length);
          continue;
        }
        if (this.buf.length > MAX_TAG_BUFFER_CHARS) {
          out += this.advanceNormalText(this.buf);
          this.buf = "";
        }
        break;
      }
    }

    return out;
  }

  flush(): string {
    if (!this.buf) return "";
    const rem = this.buf;
    this.buf = "";
    return this.advanceNormalText(rem);
  }
}
