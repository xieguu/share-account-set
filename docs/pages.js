const copyButton = document.querySelector('#copy-command');
const copyStatus = document.querySelector('#copy-status');
let resetTimer;

copyButton.addEventListener('click', async () => {
  clearTimeout(resetTimer);
  try {
    await navigator.clipboard.writeText(document.querySelector('#install-command').textContent.trim());
    copyButton.textContent = '已复制';
    copyStatus.textContent = '启动命令已复制到剪贴板。';
  } catch {
    copyButton.textContent = '请选中命令复制';
    copyStatus.textContent = '浏览器未允许写入剪贴板，请选中命令手动复制。';
  }
  resetTimer = setTimeout(() => { copyButton.textContent = '复制命令'; }, 3000);
});
