import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "native/**/target/**"] },
  ...tseslint.configs.recommended,
);
