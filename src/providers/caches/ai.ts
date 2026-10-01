import type { FindingProvider } from "../../ports/providers.js";
import { createRootsProvider, type CacheRoot } from "./roots.js";

const ID = "cache.ai";
const VERSION = 1;

/**
 * Model stores are listed as `active`, which is what keeps them out of a
 * cleanup suggestion. Weights are a download measured in gigabytes and
 * sometimes a licence acceptance; they look like cache because of where they
 * live, and they are not.
 */
const ROOTS: readonly CacheRoot[] = [
  {
    slug: "huggingface",
    segments: [".cache", "huggingface"],
    title: "Hugging Face model and dataset store",
    evidence: [
      "Downloaded weights and datasets, not disposable cache: some need a licence acceptance to fetch again.",
    ],
    active: true,
    regenerationCost: "Re-downloaded, which is gigabytes per model and may need the original credentials.",
  },
  {
    slug: "ollama",
    segments: [".ollama", "models"],
    title: "Ollama model store",
    evidence: ["Pulled models. `ollama rm` removes one model at a time and knows what is still referenced."],
    active: true,
    actions: ["manager"],
    regenerationCost: "Re-pulled, which is gigabytes per model.",
  },
  {
    slug: "torch",
    segments: [".cache", "torch"],
    title: "PyTorch hub cache",
    evidence: ["Checkpoints downloaded by torch.hub and the pretrained model APIs."],
    active: true,
    regenerationCost: "Re-downloaded on the next load of each checkpoint.",
  },
  {
    slug: "keras",
    segments: [".keras"],
    title: "Keras model and dataset store",
    evidence: ["Downloaded weights and datasets, alongside the Keras configuration file."],
    active: true,
    regenerationCost: "Re-downloaded on the next load.",
  },
  {
    slug: "whisper",
    segments: [".cache", "whisper"],
    title: "Whisper model store",
    evidence: ["Downloaded speech model weights."],
    active: true,
    regenerationCost: "Re-downloaded, which is hundreds of megabytes per model.",
  },
  {
    slug: "transformers-legacy",
    segments: [".cache", "torch", "transformers"],
    title: "Transformers cache (older location)",
    evidence: ["Where older Transformers releases kept downloaded weights."],
    active: true,
    regenerationCost: "Re-downloaded on the next load.",
  },
];

/** Downloaded model weights, which live in cache directories and are not cache. */
export function createAiCacheProvider(): FindingProvider {
  return createRootsProvider({
    id: ID,
    version: VERSION,
    category: "ai-cache",
    what: "model stores",
    roots: ROOTS,
  });
}
