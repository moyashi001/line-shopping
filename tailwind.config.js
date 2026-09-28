/** Tailwind CSS 設定（styles.css の生成用） */
module.exports = {
  content: ['./index.html', './app.js'],
  theme: {
    extend: {
      colors: { line: { DEFAULT: '#06C755', dark: '#05A847', light: '#E6F9EE' } },
      fontFamily: { sans: ['"Hiragino Sans"', '"Noto Sans JP"', 'system-ui', 'sans-serif'] },
    },
  },
};
