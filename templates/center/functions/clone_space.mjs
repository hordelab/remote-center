export const spec = {
  name: 'clone_space',
  description: 'Clone a git repository or an existing space into a new space.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Name of an existing space, or a git URL to clone.' },
      name: { type: 'string', description: 'Optional name for the new space (required when cloning an existing space).' },
    },
    required: ['source'],
  },
};

export default async function (args, ctx) {
  return await ctx.api.cloneSpace(args.source, args.name);
}