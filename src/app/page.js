'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import { Target, Brain, Trophy, Flame, AlertCircle } from 'lucide-react';

const ADJECTIVES = ['Alpha', 'Neuro', 'Synapse', 'Cortex', 'Quantum', 'Logic'];
const NOUNS = ['Thinker', 'Sage', 'Solver', 'Dynamo', 'Brain', 'Vector'];
const COLORS = ['#38BDF8', '#F43F5E', '#10B981', '#A855F7', '#F59E0B', '#EC4899'];

export default function BrainGridGame() {
  const [tiles, setTiles] = useState([]);
  const [gameState, setGameState] = useState({ current_target: 1 });
  const [user, setUser] = useState({ name: '', color: '' });
  const [score, setScore] = useState(0);
  const [errorFlash, setErrorFlash] = useState(null);

  // Initialize identity and board state configuration
  useEffect(() => {
    const generatedName = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
    const generatedColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    setUser({ name: generatedName, color: generatedColor });

    const pullInitialMatchData = async () => {
      const { data: tilesData } = await supabase.from('brain_tiles').select('*').order('id', { ascending: true });
      const { data: gameData } = await supabase.from('brain_game').select('*').eq('id', 1).single();
      
      if (tilesData) setTiles(tilesData);
      if (gameData) setGameState(gameData);
    };
    pullInitialMatchData();
  }, []);

  // Handle Real-time WebSocket Synchronizations
  useEffect(() => {
    const systemChannel = supabase
      .channel('realtime-brain-sync')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'brain_tiles' }, (payload) => {
        setTiles((prev) => prev.map((t) => (t.id === payload.new.id ? payload.new : t)));
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'brain_game' }, (payload) => {
        setGameState(payload.new);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(systemChannel);
    };
  }, []);

  // Process Tile Interaction & Handle Conflicts
  const handleTileSelection = async (tile) => {
    // Return early if tile is claimed or incorrect
    if (tile.owner_color) return;

    if (tile.value !== gameState.current_target) {
      setErrorFlash(tile.id);
      setTimeout(() => setErrorFlash(null), 600);
      return;
    }

    const nextTargetValue = gameState.current_target + 1;

    // Optimistic UI updates to provide instant local execution feel
    setTiles((prev) => prev.map((t) => t.id === tile.id ? { ...t, owner_name: user.name, owner_color: user.color } : t));
    setGameState({ current_target: nextTargetValue });
    setScore((prev) => prev + 10);

    // Write to DB sequentially. Postgres guarantees atomicity.
    const { data: tileUpdated, error: tileErr } = await supabase
      .from('brain_tiles')
      .update({ owner_name: user.name, owner_color: user.color })
      .eq('id', tile.id)
      .is('owner_color', null);

    const { error: gameErr } = await supabase
      .from('brain_game')
      .update({ current_target: nextTargetValue })
      .eq('id', 1)
      .eq('current_target', gameState.current_target);

    // Rollback changes if a race condition collision occurred with another user
    if (tileErr || gameErr) {
      const { data: rollbackTiles } = await supabase.from('brain_tiles').select('*').order('id', { ascending: true });
      const { data: rollbackGame } = await supabase.from('brain_game').select('*').eq('id', 1).single();
      if (rollbackTiles) setTiles(rollbackTiles);
      if (rollbackGame) setGameState(rollbackGame);
      setScore((prev) => Math.max(0, prev - 10));
    }
  };

  // Compile realtime stats rankings
  const leaderboard = useMemo(() => {
    const tracking = {};
    tiles.forEach((t) => {
      if (t.owner_color) {
        tracking[t.owner_color] = {
          color: t.owner_color,
          name: t.owner_name,
          count: (tracking[t.owner_color]?.count || 0) + 1,
        };
      }
    });
    return Object.values(tracking).sort((a, b) => b.count - a.count).slice(0, 4);
  }, [tiles]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center p-4 md:p-8 font-sans select-none selection:bg-transparent">
      
      {/* HUD Header Status Layout */}
      <header className="w-full max-w-6xl flex flex-col md:flex-row justify-between items-center gap-6 border-b border-slate-900 pb-6 mb-8">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl">
            <Brain className="w-8 h-8 text-indigo-400 animate-pulse" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-white uppercase">Synapse Sprint</h1>
            <p className="text-sm text-slate-400">Node identity: <span className="font-bold" style={{ color: user.color }}>{user.name}</span></p>
          </div>
        </div>

        {/* Global Target Broadcaster Matrix */}
        <div className="flex items-center gap-6 bg-slate-900/60 border border-slate-800/80 px-6 py-3 rounded-2xl backdrop-blur-md shadow-xl">
          <div className="flex items-center gap-3">
            <Target className="w-5 h-5 text-rose-500" />
            <span className="text-xs font-mono tracking-widest text-slate-400 uppercase">Target Objective:</span>
          </div>
          <div className="text-3xl font-black font-mono text-white px-4 py-1 bg-rose-500/10 border border-rose-500/30 rounded-xl shadow-inner">
            {gameState.current_target <= 100 ? gameState.current_target : 'FINISHED'}
          </div>
        </div>

        <div className="flex items-center gap-3 bg-slate-900/40 border border-slate-800/40 px-4 py-2 rounded-xl">
          <Flame className="w-4 h-4 text-amber-500" />
          <span className="text-xs font-mono font-bold text-slate-300">Your Score: {score} pts</span>
        </div>
      </header>

      {/* Main Grid Viewport Arena */}
      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-4 gap-8 w-full items-start">
        
        {/* Arena Grid Blocks */}
        <div className="lg:col-span-3 bg-slate-900/20 border border-slate-900 rounded-3xl p-4 md:p-6 shadow-2xl backdrop-blur-sm">
          <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
            {tiles.map((tile) => {
              const isError = errorFlash === tile.id;
              return (
                <motion.button
                  key={tile.id}
                  onClick={() => handleTileSelection(tile)}
                  disabled={tile.owner_color !== null || gameState.current_target > 100}
                  animate={isError ? { x: [-6, 6, -6, 6, 0] } : {}}
                  transition={{ duration: 0.4 }}
                  whileHover={{ scale: tile.owner_color ? 1 : 1.06, zIndex: 10 }}
                  whileTap={{ scale: 0.96 }}
                  className="aspect-square w-full rounded-xl flex flex-col items-center justify-center border p-1 relative transition-all group overflow-hidden cursor-pointer"
                  style={{
                    backgroundColor: tile.owner_color ? `${tile.owner_color}15` : isError ? '#31121A' : '#0F172A',
                    borderColor: tile.owner_color ? tile.owner_color : isError ? '#F43F5E' : '#1E293B'
                  }}
                >
                  {tile.owner_color ? (
                    // Captured Block Appearance Layout
                    <div className="flex flex-col items-center justify-center">
                      <span className="text-xs font-mono font-black" style={{ color: tile.owner_color }}>{tile.value}</span>
                      <span className="text-[8px] font-medium opacity-60 truncate max-w-[50px]" style={{ color: tile.owner_color }}>{tile.owner_name.split(' ')[0]}</span>
                    </div>
                  ) : (
                    // Active Expression Appearance Layout
                    <span className="text-xs font-mono font-bold text-slate-300 group-hover:text-white transition-colors">
                      {tile.expression}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* Real-time Insights Side-Panel */}
        <div className="flex flex-col gap-6 w-full">
          {/* Realtime Standings Board */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-5 shadow-lg backdrop-blur-md">
            <h3 className="text-xs font-bold tracking-widest uppercase text-slate-400 flex items-center gap-2 mb-4">
              <Trophy className="w-4 h-4 text-amber-500" /> Faction Ranking
            </h3>
            <div className="flex flex-col gap-2">
              <AnimatePresence>
                {leaderboard.map((team, index) => (
                  <motion.div
                    key={team.color}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-900"
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <span className="text-xs font-mono font-black text-slate-600">#{index + 1}</span>
                      <div className="h-3 w-3 rounded-full flex-shrink-0 animate-pulse" style={{ backgroundColor: team.color }} />
                      <span className="text-xs font-semibold truncate text-slate-200" style={{ color: team.color }}>{team.name}</span>
                    </div>
                    <span className="text-xs font-mono font-bold px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-lg text-slate-300">
                      {team.count} cells
                    </span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {leaderboard.length === 0 && (
                <div className="text-center py-6 border border-dashed border-slate-800 rounded-xl text-xs text-slate-500 italic flex flex-col items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-slate-600" /> Scan the formulas and track down target number 1!
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
