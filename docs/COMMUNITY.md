# Kyberion community guide

Kyberion is an open-source, self-hostable organization work loop engine. The
shortest way to understand the project is to follow one outcome through the
loop:

```text
intent → mission → worker execution → evidence → review → organizational memory
```

The repository is pre-1.0 and actively evolving. Small, well-scoped feedback
is especially valuable because it helps us make the first successful run,
contribution, and production deployment easier for the next person.

## Where to start

| You want to…                             | Use this path                                                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask how to install or use Kyberion       | [GitHub Discussions → Q&A](https://github.com/famaoai-creator/kyberion/discussions/categories/q-a)                                                                                                 |
| Share a workflow, result, or integration | [GitHub Discussions → Show and tell](https://github.com/famaoai-creator/kyberion/discussions/categories/show-and-tell)                                                                             |
| Report a reproducible defect             | [Bug report](https://github.com/famaoai-creator/kyberion/issues/new?template=bug.md)                                                                                                               |
| Propose a focused improvement            | [Feature request](https://github.com/famaoai-creator/kyberion/issues/new?template=feature.md)                                                                                                      |
| Find a small contribution                | Issues labelled [`good first issue`](https://github.com/famaoai-creator/kyberion/labels/good%20first%20issue) or [`help wanted`](https://github.com/famaoai-creator/kyberion/labels/help%20wanted) |
| Report a security problem                | Follow [`SECURITY.md`](../SECURITY.md); do not open a public issue                                                                                                                                 |

Please search existing discussions and issues before opening a new thread. A
short reproduction, expected result, actual result, and environment details
are more useful than a long description of a suspected cause.

## The five-minute first contribution

1. Read [`docs/QUICKSTART.md`](./QUICKSTART.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md).
2. Run `pnpm install`, `pnpm build`, and `pnpm doctor`.
3. Choose one small issue and state the intended acceptance condition before coding.
4. Make one focused change and run the narrowest relevant test immediately.
5. Open a pull request with the change, evidence, and any remaining limitation.

For architecture work, start with [`docs/developer/TOUR.md`](./developer/TOUR.md),
then use [`docs/developer/EXTENSION_POINTS.md`](./developer/EXTENSION_POINTS.md)
for the supported extension seams.

## How a contribution is reviewed

Kyberion treats “done” as an evidence-backed result. A useful pull request
therefore explains:

- the user or operator outcome;
- the files and boundary being changed;
- the validation command and its result;
- any external dependency, permission, or platform limitation.

Mission and governance changes also need to preserve tenant scope, data tiers,
approval boundaries, and the canonical work-item context chain. See the
repository [`AGENTS.md`](../AGENTS.md) and the relevant governance document
before changing those areas.

## Conversation norms

Be specific, kind, and curious. Maintainers may ask for a smaller reproduction
or a narrower change while the project is pre-1.0. That is a way to keep the
reviewable surface small, not a rejection of the underlying idea.

The project follows the [Code of Conduct](../CODE_OF_CONDUCT.md). For roadmap
context, see [`docs/PRODUCTIZATION_ROADMAP.md`](./PRODUCTIZATION_ROADMAP.md).
