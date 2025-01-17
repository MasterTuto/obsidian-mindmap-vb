import { wrapFunction } from 'markmap-common'
import { ITransformPlugin } from 'markmap-lib'


type TokenWithChildren = Remarkable.Remarkable.Token & {
  content?: string
  children?: TokenWithChildren[]
}

/*
 *  Replace all angle brackets with HTML character entities
 */
export const htmlEscapePlugin: ITransformPlugin = {
  name: 'htmlescape',
  config: {
    version: {
      htmlescape: '1.0',
    },
  },
  transform: transformHooks => {
    transformHooks.afterParse.tap(md => {
      md.parse = wrapFunction(md.parse, {
        after: function (ctx) {
          const escapeAll = (token: TokenWithChildren) => {
            if (token.type === 'htmltag' && token.content) {
              token.content = token.content
                .replace('<', '&lt;')
                .replace('>', '&gt;')
            }

            if (token.children) {
              token.children = token.children.map(escapeAll)
            }

            return token
          }

          ctx.result = ctx.result!.map(escapeAll)
        },
      })
    })

    return { styles: void 0, scripts: void 0 }
  },
}
