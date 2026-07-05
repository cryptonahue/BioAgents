import "dotenv/config";
import { VectorSearchWithDocuments } from "../src/embeddings/vectorSearchWithDocs";
import { getDocumentIngestionQueue } from "../src/services/queue/queues";
import { isJobQueueEnabled } from "../src/services/queue/connection";
import { DocumentProcessor } from "../src/embeddings/documentProcessor";
import { getServiceClient } from "../src/db/client";

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const docsPath = readArg("path") || process.env.KNOWLEDGE_DOCS_PATH || "docs";
  const force = hasFlag("force");
  const dryRun = hasFlag("dry-run");
  const extractBioprospecting = hasFlag("bioprospecting");
  const registerExisting = !hasFlag("no-register-existing");
  const ignorePatterns = (
    readArg("ignore") ||
    process.env.KNOWLEDGE_INGEST_IGNORE ||
    ""
  )
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);

  console.log("Starting Research Brain ingestion");
  console.log(
    JSON.stringify(
      {
        docsPath,
        force,
        dryRun,
        extractBioprospecting,
        registerExisting,
        ignorePatterns,
        useJobQueue: isJobQueueEnabled(),
      },
      null,
      2,
    ),
  );

  const vectorSearch = new VectorSearchWithDocuments();

  if (dryRun) {
    const report = await vectorSearch.dryRunIngestDirectory(docsPath, {
      force,
      ignorePatterns: ignorePatterns.length > 0 ? ignorePatterns : undefined,
    });
    console.log("Dry run completed");
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // When USE_JOB_QUEUE=true, enqueue jobs instead of sequential processing
  if (isJobQueueEnabled()) {
    const supabase = getServiceClient();
    const documentProcessor = new DocumentProcessor();

    // List all files
    const files = await documentProcessor.listSupportedFiles(docsPath, {
      ignorePatterns: ignorePatterns.length > 0 ? ignorePatterns : undefined,
    });

    if (files.length === 0) {
      console.log("No supported files found in directory");
      return;
    }

    // Create ingestion run record
    const { data, error } = await supabase
      .from("research_ingestion_runs")
      .insert({
        docs_path: docsPath,
        status: "running",
        total_files: files.length,
        metadata: {
          force,
          extractBioprospecting,
 },
      })
      .select("id")
      .single();

    if (error) {
      console.error("Failed to create ingestion run:", error);
      process.exit(1);
    }

    const runId = (data as any).id;
    console.log(`Created ingestion run: ${runId}`);

    // Enqueue jobs for each file
    const queue = getDocumentIngestionQueue();
    for (const filePath of files) {
      await queue.add("document-ingestion", {
        runId,
        filePath,
        options: {
          force,
          extractBioprospecting,
        },
      });
    }

    console.log(`Enqueued ${files.length} ingestion jobs`);
    console.log(
      JSON.stringify(
        {
          runId,
          status: "running",
          totalFiles: files.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  // When USE_JOB_QUEUE=false, use existing sequential behavior
  const result = await vectorSearch.ingestDirectory(docsPath, {
    force,
    registerExisting,
    extractBioprospecting,
    ignorePatterns: ignorePatterns.length > 0 ? ignorePatterns : undefined,
  });

  console.log("Ingestion completed");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Ingestion failed");
  console.error(error);
  process.exit(1);
});
