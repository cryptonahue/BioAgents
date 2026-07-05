import { createHash } from "crypto";
import matter from "front-matter";
import { createReadStream } from "fs";
import fs from "fs/promises";
import mammoth from "mammoth";
import path from "path";
import { PDFParse } from "pdf-parse";
import logger from "../utils/logger";

export interface ProcessedDocument {
  title: string;
  content: string;
  metadata: {
    filePath: string;
    type: string;
    size: number;
    lastModified: Date;
    contentHash: string;
    [key: string]: any;
  };
}

const SUPPORTED_EXTENSIONS = new Set([".md", ".docx", ".pdf", ".txt"]);

export interface DocumentIdentity {
  title: string;
  filePath: string;
  type: string;
  size: number;
  lastModified: Date;
  contentHash: string;
}

export interface FileListOptions {
  ignorePatterns?: string[];
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function matchesIgnorePattern(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  return patterns.some((pattern) => {
    const value = pattern.trim().replace(/\\/g, "/").toLowerCase();
    if (!value) return false;
    return basename === value || normalized.includes(value);
  });
}

export class DocumentProcessor {
  async getFileIdentity(filePath: string): Promise<DocumentIdentity | null> {
    const stats = await fs.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();

    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return null;
    }

    return {
      title: path.basename(filePath),
      filePath,
      type: ext.slice(1),
      size: stats.size,
      lastModified: stats.mtime,
      contentHash: await sha256File(filePath),
    };
  }

  async processFile(filePath: string): Promise<ProcessedDocument | null> {
    const identity = await this.getFileIdentity(filePath);
    if (!identity) {
      logger.warn(
        `Unsupported file type: ${path.extname(filePath).toLowerCase()}`,
      );
      return null;
    }

    const ext = path.extname(filePath).toLowerCase();
    const fileName = identity.title; // Keep extension in filename

    let content: string;
    let frontMatterData: any = {};

    try {
      switch (ext) {
        case ".md":
          const rawContent = await fs.readFile(filePath, "utf-8");
          const parsed = matter(rawContent);
          frontMatterData = parsed.attributes;
          content = parsed.body;
          break;

        case ".txt":
          content = await fs.readFile(filePath, "utf-8");
          break;

        case ".docx":
          const buffer = await fs.readFile(filePath);
          const result = await mammoth.extractRawText({ buffer });
          content = result.value;
          break;

        case ".pdf":
          try {
            const parser = new PDFParse({ url: filePath });
            const pdfResult = await parser.getText();
            await parser.destroy();
            content = pdfResult.text;
          } catch (pdfError: any) {
            logger.error(
              `PDF parsing error for ${fileName}: ${pdfError.message}`,
            );
            throw new Error(
              `Failed to parse PDF ${fileName}: ${pdfError.message}`,
            );
          }
          break;

        default:
          logger.warn(`Unsupported file type: ${ext}`);
          return null;
      }

      return {
        title: fileName,
        content: content.trim(),
        metadata: {
          filePath,
          type: identity.type,
          size: identity.size,
          lastModified: identity.lastModified,
          contentHash: identity.contentHash,
          ...frontMatterData,
        },
      };
    } catch (error) {
      logger.error(`Error processing ${filePath}:`, error as any);
      return null;
    }
  }

  async processDirectory(dirPath: string): Promise<ProcessedDocument[]> {
    const documents: ProcessedDocument[] = [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          // Recursively process subdirectories
          const subDocs = await this.processDirectory(fullPath);
          documents.push(...subDocs);
        } else if (entry.isFile()) {
          const doc = await this.processFile(fullPath);
          if (doc) {
            documents.push(doc);
            logger.info(`✅ Processed: ${doc.title} (${doc.metadata.type})`);
          }
        }
      }
    } catch (error) {
      logger.error(`Error reading directory ${dirPath}:`, error as any);
    }

    return documents;
  }

  async listSupportedFiles(
    dirPath: string,
    options: FileListOptions = {},
  ): Promise<string[]> {
    const files: string[] = [];
    const ignorePatterns = options.ignorePatterns || [];

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          files.push(...(await this.listSupportedFiles(fullPath, options)));
        } else if (
          entry.isFile() &&
          SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
          !matchesIgnorePattern(fullPath, ignorePatterns)
        ) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      logger.error(`Error listing directory ${dirPath}:`, error as any);
    }

    return files.sort((a, b) => a.localeCompare(b));
  }
}
