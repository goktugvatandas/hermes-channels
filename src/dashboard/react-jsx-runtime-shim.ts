const React = window.__HERMES_PLUGIN_SDK__.React

export const Fragment = React.Fragment

export function jsx(type: import('react').ElementType, props: Record<string, unknown>, key?: string) {
  return React.createElement(type, key === undefined ? props : { ...props, key })
}

export const jsxs = jsx
