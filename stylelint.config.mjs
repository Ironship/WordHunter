/** @type {import("stylelint").Config} */
export default {
  extends: ["stylelint-config-recommended"],
  overrides: [
    {
      files: ["**/*.html"],
      customSyntax: "postcss-html"
    }
  ],
  rules: {
    "declaration-block-no-duplicate-properties": [
      true,
      { ignore: ["consecutive-duplicates-with-different-syntaxes"] }
    ],
    "no-descending-specificity": null
  }
};
