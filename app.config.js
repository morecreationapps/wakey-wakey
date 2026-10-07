/** GitHub Pages uses a project subpath; local and native builds retain root paths. */
export default ({ config }) => {
  const pages = process.env.WAKEY_DEPLOY_TARGET === "github-pages";
  return {
    ...config,
    githubUrl: "https://github.com/morecreationapps/wakey-wakey",
    web: { ...config.web, output: "single" },
    experiments: {
      ...config.experiments,
      baseUrl: pages ? "/wakey-wakey" : "",
    },
    extra: { ...config.extra, publicReleaseReviewed: false },
  };
};
