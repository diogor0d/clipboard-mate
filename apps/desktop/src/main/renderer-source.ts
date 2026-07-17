export const getDevelopmentRendererUrl = (
  isPackaged: boolean,
  environment: Pick<NodeJS.ProcessEnv, "ELECTRON_RENDERER_URL"> = process.env,
): string | undefined =>
  isPackaged ? undefined : environment.ELECTRON_RENDERER_URL;
