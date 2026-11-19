/**
 * 转换表达式的轻量解析器。
 * 解析标识符（字段引用），用于：
 *  1) 注册时校验引用字段是否存在；
 *  2) 建立字段级血缘边。
 * 标识符规则：字母/下划线开头，后接字母数字下划线或点号（支持 source.col 形式）。
 */

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_.]*/y;
const FUNCTIONS = new Set([
  'SUM',
  'AVG',
  'COUNT',
  'MAX',
  'MIN',
  'COALESCE',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'CAST',
  'ROUND',
  'IF',
  'NULLIF',
  'DISTINCT',
  'GROUP',
  'BY',
  'AS',
  'IN',
  'IS',
  'LIKE',
  'BETWEEN',
  'OVER',
  'PARTITION',
  'ORDER',
  'ASC',
  'DESC',
  'LIMIT',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'ON',
  'WHERE',
  'HAVING',
]);
const LITERAL_RE = /(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\b\d+(?:\.\d+)?\b)/y;

/**
 * @returns {{ identifiers: string[], literals: string[], keywords: string[] }}
 */
export function tokenizeExpression(expr) {
  const src = String(expr ?? '');
  const identifiers = [];
  const literals = [];
  const keywords = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    LITERAL_RE.lastIndex = i;
    const lit = LITERAL_RE.exec(src);
    if (lit) {
      literals.push(lit[0]);
      i = LITERAL_RE.lastIndex;
      continue;
    }
    IDENTIFIER_RE.lastIndex = i;
    const m = IDENTIFIER_RE.exec(src);
    if (m) {
      const raw = m[0];
      i = IDENTIFIER_RE.lastIndex;
      const upper = raw.toUpperCase();
      if (FUNCTIONS.has(upper)) {
        keywords.push(upper);
      } else if (isBooleanOrNull(upper)) {
        keywords.push(upper);
      } else {
        identifiers.push(raw);
      }
      continue;
    }
    // 运算符 / 括号 / 逗号 / 点号已包含在标识符匹配中，跳过其余单字符
    i += 1;
  }
  return { identifiers: [...new Set(identifiers)], literals, keywords };
}

function isBooleanOrNull(upper) {
  return upper === 'TRUE' || upper === 'FALSE' || upper === 'NULL' || upper === 'AND' || upper === 'OR' || upper === 'NOT';
}

/**
 * 把表达式里的标识符解析成具体字段引用。
 * 支持两种写法：
 *   1) 全限定名  objectName.fieldName
 *   2) 裸字段名  fieldName —— 在提供的可见字段集合中按名称查找
 *
 * @param {string} expression
 * @param {Map<string, {objectId:string, name:string}>} fieldByQualifiedName key: objectName.fieldName
 * @param {Map<string, {objectId:string, name:string}>} fieldBySimpleName   key: fieldName
 * @returns {{ refs: Array<{objectId:string, fieldName:string, token:string}>, unresolved: string[] }}
 */
export function resolveExpression(expression, fieldByQualifiedName, fieldBySimpleName) {
  const { identifiers } = tokenizeExpression(expression);
  const refs = [];
  const unresolved = [];
  const seen = new Set();
  for (const token of identifiers) {
    let hit = fieldByQualifiedName.get(token);
    if (!hit && token.includes('.')) {
      // 全限定名是权威写法：对象.字段 未命中即视为无法解析，
      // 不回退裸名匹配，避免静默指向其他对象的同名字段。
      unresolved.push(token);
      continue;
    }
    if (!hit) hit = fieldBySimpleName.get(token);
    if (!hit) {
      unresolved.push(token);
      continue;
    }
    const key = `${hit.objectId}.${hit.fieldName}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ objectId: hit.objectId, fieldName: hit.fieldName, token });
    }
  }
  return { refs, unresolved };
}
