import './globals.css';

export const metadata = {
  title: 'Warframe Market Terminal',
  description: 'Live arbitrage and ducat deal tracker for warframe.market',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
