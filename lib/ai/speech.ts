/**
 * Voice-output sanitiser for the Siri endpoint.
 * Strips markdown/formatting so Siri reads natural sentences, not syntax.
 */
export function toSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")            // code blocks
    .replace(/`([^`]*)`/g, "$1")                 // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")   // links/images → label
    .replace(/^#{1,6}\s+/gm, "")                 // headings
    .replace(/(\*\*|__)(.*?)\1/g, "$2")          // bold
    .replace(/(\*|_)(.*?)\1/g, "$2")             // italics
    .replace(/^\s*[-*•]\s+/gm, "")               // bullets
    .replace(/^\s*\d+\.\s+/gm, "")               // numbered lists
    .replace(/\|/g, " ")                          // table pipes
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
