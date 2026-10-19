export function buildThreadHeaderSubtitle(input: {
  readonly projectTitle: string | null | undefined;
  readonly environmentLabel: string | null | undefined;
  readonly container: boolean | undefined;
}): string {
  return [input.projectTitle, input.environmentLabel, input.container ? "Container" : null]
    .filter(Boolean)
    .join(" · ");
}
