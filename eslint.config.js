import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: true,
  ignores: ['dist', 'src/protect/schemas.ts', 'spec', '.github/instructions'],
})
