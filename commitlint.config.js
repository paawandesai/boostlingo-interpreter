export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Bodies carry rationale and co-author trailers; long URLs are fine there.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
}
