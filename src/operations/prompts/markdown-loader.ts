import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

// Get the current directory, handling both ES modules and CommonJS
const getCurrentDirname = (): string => {
  // For Jest tests, __dirname is available and points to the test directory
  // Only use __dirname if it contains 'test' (indicating we're in Jest environment)
  if (typeof __dirname !== 'undefined' && __dirname.includes('test')) {
    return __dirname;
  }

  // For production and development, use filesystem detection
  const cwd = process.cwd();
  const distPath = path.join(cwd, 'dist', 'operations', 'prompts');
  const srcPath = path.join(cwd, 'src', 'operations', 'prompts');

  // Try dist first (production), then src (development/test)
  if (fs.existsSync(path.join(distPath, 'templates'))) {
    return distPath;
  }
  if (fs.existsSync(path.join(srcPath, 'templates'))) {
    return srcPath;
  }

  // Final fallback - return dist path even if templates don't exist yet
  // This helps in production builds where templates should be there
  return distPath;
};

const currentDirname = getCurrentDirname();

interface FrontmatterData {
  title?: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  [key: string]: any;
}

interface ParsedMarkdown {
  frontmatter: FrontmatterData;
  content: string;
}

/**
 * Parse markdown file with frontmatter support
 */
function parseMarkdownWithFrontmatter(content: string): ParsedMarkdown {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (match) {
    try {
      const frontmatter = yaml.load(match[1]) as FrontmatterData || {};
      return {
        frontmatter,
        content: match[2].trim(),
      };
    } catch (error) {
      console.warn('Failed to parse YAML frontmatter:', error);
      return {
        frontmatter: {},
        content: content.trim(),
      };
    }
  }

  // No frontmatter found, return content as-is
  return {
    frontmatter: {},
    content: content.trim(),
  };
}

/**
 * Load markdown prompt template and substitute variables
 */
export function loadMarkdownPrompt(templateName: string, args: Record<string, string>): string {
  const templatePath = path.join(currentDirname, 'templates', `${templateName}.md`);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Prompt template not found: ${templateName}.md`);
  }

  const rawContent = fs.readFileSync(templatePath, 'utf-8');
  const { content } = parseMarkdownWithFrontmatter(rawContent);

  // Simple variable substitution using {var} notation
  let processedContent = content;
  for (const [key, value] of Object.entries(args)) {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    processedContent = processedContent.replace(regex, value);
  }

  return processedContent;
}

/**
 * Extract title from markdown file (frontmatter or first # heading)
 */
export function extractMarkdownTitle(templateName: string): string {
  const templatePath = path.join(currentDirname, 'templates', `${templateName}.md`);

  if (!fs.existsSync(templatePath)) {
    return templateName;
  }

  const rawContent = fs.readFileSync(templatePath, 'utf-8');
  const { frontmatter, content } = parseMarkdownWithFrontmatter(rawContent);

  // Use frontmatter title if available
  if (frontmatter.title) {
    return frontmatter.title;
  }

  // Fallback to first # heading
  const titleMatch = content.match(/^#\s+(.+)$/m);
  return titleMatch ? titleMatch[1] : templateName;
}

/**
 * Extract description from markdown file (frontmatter or content after first heading)
 */
export function extractMarkdownDescription(templateName: string): string {
  const templatePath = path.join(currentDirname, 'templates', `${templateName}.md`);

  if (!fs.existsSync(templatePath)) {
    return '';
  }

  const rawContent = fs.readFileSync(templatePath, 'utf-8');
  const { frontmatter, content } = parseMarkdownWithFrontmatter(rawContent);

  // Use frontmatter description if available
  if (frontmatter.description) {
    return frontmatter.description;
  }

  // Fallback to content-based extraction
  const lines = content.split('\n');
  const descriptionLines: string[] = [];
  let foundTitle = false;

  for (const line of lines) {
    if (line.startsWith('# ') && !foundTitle) {
      foundTitle = true;
      continue;
    }

    if (foundTitle && line.trim() === '') {
      continue; // Skip empty lines after title
    }

    if (foundTitle && line.includes('{')) {
      break; // Stop at first variable usage
    }

    if (foundTitle) {
      descriptionLines.push(line);
      if (descriptionLines.length >= 3) break; // Limit description length
    }
  }

  return descriptionLines.join(' ').trim();
}

/**
 * Extract arguments from markdown file frontmatter
 */
export function extractMarkdownArguments(templateName: string): Array<{
  name: string;
  description?: string;
  required?: boolean;
}> {
  const templatePath = path.join(currentDirname, 'templates', `${templateName}.md`);

  if (!fs.existsSync(templatePath)) {
    return [];
  }

  const rawContent = fs.readFileSync(templatePath, 'utf-8');
  const { frontmatter } = parseMarkdownWithFrontmatter(rawContent);

  return frontmatter.arguments || [];
}

/**
 * Get all available template names by scanning the templates directory
 */
export function getAvailableTemplates(): string[] {
  const templatesDir = path.join(currentDirname, 'templates');

  if (!fs.existsSync(templatesDir)) {
    return [];
  }

  try {
    return fs.readdirSync(templatesDir)
      .filter(file => file.endsWith('.md'))
      .map(file => file.replace('.md', ''))
      .sort();
  } catch (error) {
    console.warn('Failed to read templates directory:', error);
    return [];
  }
}