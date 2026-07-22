const fs = require('fs');

const membersData = fs.readFileSync('./public/members.js', 'utf8');

const barcodeMatch = membersData.match(/var BARCODE_MEMBERS = (\{[\s\S]*?\});/);
const readableMatch = membersData.match(/var BARCODE_READABLE = (\{[\s\S]*?\});/);
const infoMatch = membersData.match(/var MEMBER_INFO = (\{[\s\S]*?\});/);

if (!barcodeMatch || !readableMatch || !infoMatch) {
  console.error('无法解析 members.js');
  process.exit(1);
}

const BARCODE_MEMBERS = eval('(' + barcodeMatch[1] + ')');
const BARCODE_READABLE = eval('(' + readableMatch[1] + ')');
const MEMBER_INFO = eval('(' + infoMatch[1] + ')');

const lines = ['条码,姓名,登记序号,班级,部门,可读格式'];

for (const barcode of Object.keys(BARCODE_MEMBERS)) {
  const name = BARCODE_MEMBERS[barcode];
  const readable = BARCODE_READABLE[barcode] || '';
  
  let memberId = '';
  let className = '';
  let department = '';
  
  if (MEMBER_INFO[name]) {
    const info = MEMBER_INFO[name];
    const idMatch = info.match(/登记序号[：:]\s*(.+)/);
    const classMatch = info.match(/班级[：:]\s*(.+)/);
    const deptMatch = info.match(/所属部门[：:]\s*(.+)/);
    
    if (idMatch) memberId = idMatch[1].trim();
    if (classMatch) className = classMatch[1].trim();
    if (deptMatch) department = deptMatch[1].trim();
  }
  
  const escapedName = name.includes(',') ? `"${name}"` : name;
  lines.push(`${barcode},${escapedName},${memberId},${className},${department},${readable}`);
}

fs.writeFileSync('./public/members.csv', lines.join('\n'), 'utf8');
console.log('members.csv 已生成，共 ' + (lines.length - 1) + ' 条记录');
