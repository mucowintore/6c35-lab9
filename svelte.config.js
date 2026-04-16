import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const isDev = process.argv.includes('dev');
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const defaultRepoBase = '/lab9-bikewatching';
const inferredBase = repoName ? (repoName.endsWith('.github.io') ? '' : `/${repoName}`) : defaultRepoBase;

const config = {
	kit: {
		adapter: adapter({ fallback: '404.html' }),
		paths: {
			base: isDev ? '' : process.env.BASE_PATH ?? inferredBase,
		},
	},
};

export default config;
