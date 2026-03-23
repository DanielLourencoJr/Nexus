import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "config", "prompts");
const SNIPPETS_DIR = join(PROMPTS_DIR, "snippets");
const TOOLS_DIR = join(PROMPTS_DIR, "tools");

function loadYaml(filepath) {
  return yaml.load(readFileSync(filepath, "utf8"));
}

function interpolate(text, data) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? `{{${key}}}`);
}

function resolveSnippets(snippetNames = []) {
  return snippetNames.map((name) => {
    const file = join(SNIPPETS_DIR, `${name}.yml`);
    return loadYaml(file).content ?? "";
  }).filter(Boolean);
}

export function buildPrompt(name, data = {}) {
  const base = loadYaml(join(PROMPTS_DIR, "_base.yml"));
  const prompt = loadYaml(join(PROMPTS_DIR, `${name}.yml`));

  const snippets = resolveSnippets(prompt.includes ?? []);

  const parts = [
    base.system,
    ...snippets,
    prompt.system ?? "",
  ].filter(Boolean);

  const system = interpolate(parts.join("\n\n"), data);

  return system.trim();
}

export function buildTool(name) {
  const tool = loadYaml(join(TOOLS_DIR, `${name}.yml`));

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description.trim(),
      parameters: tool.parameters,
    },
  };
}

export function buildTools(names) {
  return names.map(buildTool);
}
