import asyncio
import discord
from discord import app_commands
import os
import csv
import json
from dotenv import load_dotenv
import database

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
KEYS_FILE = "keys.csv"

# Color Palette
COLOR_INVISIBLE = 0x242429 # Modern "invisible" color
COLOR_ERROR = 0xff4d4d
COLOR_SUCCESS = 0x2ecc71
COLOR_PURPLE = 0x7F00FF

def sanitize_path(text):
    if not text: return ""
    # Remove user-specific absolute paths for privacy
    for marker in ["century-standalone", "centiant"]:
        if marker in text:
            parts = text.split(marker)
            return "...\\" + marker + parts[-1]
    return text

class MyBot(discord.Client):
    def __init__(self):
        super().__init__(intents=discord.Intents.default())
        self.tree = app_commands.CommandTree(self)
        self.active_solvers = {} # user_id -> process

    async def setup_hook(self):
        await self.tree.sync()

bot = MyBot()

async def run_node_script(script_name, args, interaction=None, env=None):
    """Executes a Node script asynchronously, provides real-time STATUS updates, and robustly parses the last JSON line."""
    try:
        if env is None:
            env = os.environ.copy()
            
        process = await asyncio.create_subprocess_exec(
            'node', script_name, *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env
        )
        
        full_stdout = []
        # Read line by line for status updates
        while True:
            line = await process.stdout.readline()
            if not line: break
            
            line_text = line.decode('utf-8', errors='ignore').strip()
            full_stdout.append(line_text)
            
            if "STATUS:" in line_text and interaction:
                status_msg = line_text.split("STATUS:")[1].strip()
                try:
                    await interaction.edit_original_response(embed=discord.Embed(description=f"<a:gearSpinning:1476343807996985488> **Processing:** {status_msg}", color=COLOR_INVISIBLE))
                except: pass
        
        # Wait for completion and capture exit code
        return_code = await process.wait()
        stderr_bytes = await process.stderr.read()
        stderr_text = stderr_bytes.decode('utf-8', errors='ignore').strip()
        
        if return_code != 0:
            return {"success": False, "error": f"Script failed (Exit {return_code}): {sanitize_path(stderr_text)}"}
            
        # Robust JSON extraction
        for line in reversed(full_stdout):
            if line.startswith('{') and line.endswith('}'):
                try:
                    return json.loads(line)
                except:
                    continue
                    
        return {"success": False, "error": "No valid JSON response found in output."}
    except Exception as e:
        return {"success": False, "error": str(e)}

class LoginModal(discord.ui.Modal, title='Century Tech Login'):
    username = discord.ui.TextInput(label='Username', placeholder='Enter your Century username...')
    password = discord.ui.TextInput(label='Password', placeholder='Enter your Century password...', style=discord.TextStyle.short)

    async def on_submit(self, interaction: discord.Interaction):
        embed = discord.Embed(description=f'🔍 Validating credentials for `{self.username.value}`...', color=COLOR_INVISIBLE)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        
        # Run auth_check.js asynchronously
        data = await run_node_script('auth_check.js', [self.username.value, self.password.value], interaction=interaction)
        
        if data.get('success'):
            name = data.get('name', 'Student')
            database.update_credentials(str(interaction.user.id), self.username.value, self.password.value, name)
            embed.description = f'<a:check:1476352876853858367> Login successful! Account `{self.username.value}` is now locked to your Discord ID.\n👋 It\'s great to see you **{name}**!'
            embed.color = COLOR_PURPLE
            embed.set_footer(text=f"Logged in as {name}")
            await interaction.edit_original_response(embed=embed)
        else:
            embed.description = f'<a:cross_animated:1476353024451543040> Login failed: {data.get("error")}'
            embed.color = COLOR_ERROR
            await interaction.edit_original_response(embed=embed)

@bot.tree.command(name="redeem", description="Redeem a 12-digit key to unlock bot access")
async def redeem(interaction: discord.Interaction, key: str):
    user = database.get_user(interaction.user.id)
    if user and user[3]: # is_redeemed
        embed = discord.Embed(description="<a:cross_animated:1476353024451543040> You have already redeemed a key!", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        return

    # Check keys.csv
    valid = False
    new_keys = []
    if os.path.exists(KEYS_FILE):
        with open(KEYS_FILE, 'r') as f:
            keys = [line.strip() for line in f.readlines()]
            if key in keys:
                valid = True
                keys.remove(key)
                new_keys = keys
            
    if valid:
        # Update keys.csv
        with open(KEYS_FILE, 'w') as f:
            for k in new_keys:
                f.write(f"{k}\n")
        
        database.redeem_user(interaction.user.id)
        embed = discord.Embed(description="<a:check:1476352876853858367> Key redeemed! Use `/login` to link your Century account.", color=COLOR_SUCCESS)
        await interaction.response.send_message(embed=embed, ephemeral=True)
    else:
        embed = discord.Embed(description="<a:cross_animated:1476353024451543040> Invalid or already used key.", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)

@bot.tree.command(name="login", description="Link your Century Tech account")
async def login(interaction: discord.Interaction):
    user = database.get_user(interaction.user.id)
    if not user or not user[3]: # is_redeemed
        embed = discord.Embed(description="<a:cross_animated:1476353024451543040> You must redeem a key first using `/redeem`.", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        return
    
    # Explicit lock check with user-facing message
    if user[4]:  # is_locked
        if str(interaction.user.id) != "442320780705923083":  # admin bypass
            embed = discord.Embed(
                title="<a:cross_animated:1476353024451543040> Credentials Locked",
                description=f"Your account is already locked to `{user[1]}`.",
                color=COLOR_ERROR
            )
            await interaction.response.send_message(embed=embed, ephemeral=True)
            return

    await interaction.response.send_modal(LoginModal())
    
@bot.tree.command(name="terminate", description="Stop your current solver session")
async def terminate(interaction: discord.Interaction):
    user_id = str(interaction.user.id)
    if user_id in bot.active_solvers:
        process = bot.active_solvers[user_id]
        if process.returncode is None:
            process.stdin.write(b"TERMINATE\n")
            await process.stdin.drain()
            embed = discord.Embed(description="<a:Siren:1476346739127746701> Termination signal sent to your solver.", color=COLOR_PURPLE)
            await interaction.response.send_message(embed=embed, ephemeral=True)
        else:
            del bot.active_solvers[user_id]
            embed = discord.Embed(description="<a:cross_animated:1476353024451543040> No active solver found.", color=COLOR_ERROR)
            await interaction.response.send_message(embed=embed, ephemeral=True)
    else:
        embed = discord.Embed(description="<a:cross_animated:1476353024451543040> You don't have an active solver running.", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)

@bot.tree.command(name="skip", description="Force the solver to skip the current question")
async def skip(interaction: discord.Interaction):
    user_id = str(interaction.user.id)
    if user_id in bot.active_solvers:
        process = bot.active_solvers[user_id]
        if process.returncode is None:
            process.stdin.write(b"SKIP\n")
            await process.stdin.drain()
            embed = discord.Embed(description="⏭️ Skip signal sent to your solver.", color=COLOR_PURPLE)
            await interaction.response.send_message(embed=embed, ephemeral=True)
        else:
            del bot.active_solvers[user_id]
            embed = discord.Embed(description="<a:cross_animated:1476353024451543040> No active solver found.", color=COLOR_ERROR)
            await interaction.response.send_message(embed=embed, ephemeral=True)
    else:
        embed = discord.Embed(description="<a:cross_animated:1476353024451543040> You don't have an active solver running.", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)

class NuggetSelect(discord.ui.Select):
    def __init__(self, user_creds, nuggets):
        self.user_creds = user_creds
        self.nuggets = nuggets
        
        options = [
            discord.SelectOption(
                label="✨ SOLVE ALL NUGGETS", 
                value="all", 
                description="Sequentially complete every nugget in this assignment.",
                emoji="⚡"
            )
        ]
        
        for i, n in enumerate(nuggets[:24]):
            options.append(discord.SelectOption(
                label=n['title'][:100], 
                value=str(i), 
                description=f"Direct jump to Nugget {i+1}",
                emoji="📖"
            ))
            
        super().__init__(placeholder="🎯 Select a target or solve all...", options=options)

    async def callback(self, interaction: discord.Interaction):
        user = self.user_creds
        
        if self.values[0] == "all":
            # Pass all URLs joined by commas to the solver
            nugget_url = ",".join([n['url'] for n in self.nuggets])
            display_title = "Full Assignment"
        else:
            idx = int(self.values[0])
            nugget_url = self.nuggets[idx]['url']
            display_title = self.nuggets[idx]['title']
            
        if str(interaction.user.id) in bot.active_solvers:
            proc = bot.active_solvers[str(interaction.user.id)]
            if proc.returncode is None:
                embed = discord.Embed(description="<a:cross_animated:1476353024451543040> **Active Session Detected**\nYou already have a solver running! Use `/terminate` to stop it first.", color=COLOR_ERROR)
                await interaction.response.send_message(embed=embed, ephemeral=True)
                return

        detected_mode = "Autonomous Diagnostic Solver" if "diagnostic" in display_title.lower() else "Autonomous Logic Engine"

        embed = discord.Embed(
            title="<a:gearSpinning:1476343807996985488> Initializing Centiant Engine",
            description=f"Target: `{display_title}`\nMode: `{detected_mode}`\nFrequency: `⚡ HIGH (MAX TURBO)`\nState: <a:LOADING:1476344927947325683> `PREPARING BROWSER...`", 
            color=COLOR_PURPLE
        )
        
        if len(user) > 5 and user[5]:
            embed.set_footer(text=f"Logged in as {user[5]}")
        await interaction.response.send_message(embed=embed, ephemeral=True)
        
        # We start the solver as a separate process
        env = os.environ.copy()
        env["CENTURY_USERNAME"] = user[1]
        env["CENTURY_PASSWORD"] = user[2]
        env["HEADLESS"] = os.getenv("HEADLESS", "true")
        env["OPENAI_API_KEY"] = os.getenv("OPENAI_API_KEY")
        
        # Start solving asynchronously!
        try:
            process = await asyncio.create_subprocess_exec(
                'node', 'century_solver.js', nugget_url,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            bot.active_solvers[str(interaction.user.id)] = process
            
            # Monitoring loop
            embed = discord.Embed(title="🚀 Solver Running", description="Starting engine...", color=COLOR_INVISIBLE)
            if len(user) > 5 and user[5]:
                embed.set_footer(text=f"Logged in as {user[5]}")
            msg = await interaction.followup.send(embed=embed, ephemeral=True)
            
            # Monitoring loop — tracks progress and sends heartbeat DMs every 5 nuggets
            nuggets_completed = 0
            last_score = "N/A"
            while True:
                line = await process.stdout.readline()
                if not line: break
                
                line_text = line.decode('utf-8', errors='ignore').strip()
                print(line_text)
                
                if "PROGRESS:" in line_text:
                    token = line_text.split("PROGRESS:")[1].strip()
                    if "SCORE:" in token:
                        data_parts = token.split("SCORE:")[1].split("|")
                        score = data_parts[0]
                        time_recorded = data_parts[1].split("TIME:")[1] if len(data_parts) > 1 else "N/A"
                        
                        last_score = score
                        nuggets_completed += 1
                        
                        status_desc = f"<a:check:1476352876853858367> Nugget Complete!\nAccuracy: **{score}%**"
                        if time_recorded != "N/A":
                            status_desc += f"\nTime Logged: **{time_recorded}**"
                            
                        embed.description = status_desc
                        embed.color = COLOR_SUCCESS
                        try:
                            await msg.edit(embed=embed)
                        except discord.NotFound: # Handle expired interaction
                            print(f"Interaction message not found for user {interaction.user.id}, likely expired.")
                            break # Exit monitoring loop if message is gone
                        except Exception as edit_e:
                            print(f"Error editing message: {edit_e}")
                        # Heartbeat DM every 5 nuggets
                        if nuggets_completed % 5 == 0:
                            try:
                                dm_embed = discord.Embed(
                                    title="⚡ Progress Update",
                                    description=f"✅ **{nuggets_completed}** nuggets completed so far!\nLatest Score: **{last_score}%**",
                                    color=COLOR_PURPLE
                                )
                                await interaction.user.send(embed=dm_embed)
                            except discord.Forbidden:
                                print(f"Could not send DM to user {interaction.user.id} (Forbidden).")
                            except Exception as dm_e:
                                print(f"Error sending DM: {dm_e}")
                    elif "NEXT_NUGGET:" in token:
                        progress_info = token.split("NEXT_NUGGET:")[1]
                        embed.description = f"⏳ Moving to next target—\nProgress: **{progress_info}** nuggets"
                        embed.color = COLOR_INVISIBLE
                        try:
                            await msg.edit(embed=embed)
                        except: pass
                elif "STATUS:" in line_text:
                    status_msg = line_text.split("STATUS:")[1].strip()
                    if "TIME|" in status_msg:
                        # Format: TIME|total=X|q=Y
                        try:
                            parts = status_msg.split("|")
                            total_s = int(parts[1].split("=")[1])
                            spoofed_s = int(parts[2].split("=")[1])
                            q_s = int(parts[3].split("=")[1])
                            
                            m_tot, s_tot = divmod(total_s, 60)
                            m_spf, s_spf = divmod(spoofed_s, 60)
                            m_q, s_q = divmod(q_s, 60)
                            
                            footer_text = f"Real: {m_tot}m {s_tot}s | Spoofed: {m_spf}m {s_spf}s (10x)"
                            if len(user) > 5 and user[5]:
                                footer_text = f"{user[5]} | {footer_text}"
                            
                            embed.set_footer(text=footer_text)
                            await msg.edit(embed=embed)
                        except: pass
                        try:
                            embed.description = f"<a:gearSpinning:1476343807996985488> **Status:** {status_msg}"
                            await msg.edit(embed=embed)
                        except: pass
                elif "SESSION COMPLETE" in line_text:
                    embed.title = "<a:check:1476352876853858367> Session Finished"
                    embed.description = "The assignment has been completed successfully."
                    embed.color = COLOR_SUCCESS
                    await msg.edit(embed=embed)
                    # Notify via DM
                    try:
                        dm_embed = discord.Embed(title="Assignment Complete", description="<a:check:1476352876853858367> Your Century assignment is finished.", color=COLOR_SUCCESS)
                        await interaction.user.send(embed=dm_embed)
                    except: pass
                    break
            
            # Remove from active trackers
            if str(interaction.user.id) in bot.active_solvers:
                del bot.active_solvers[str(interaction.user.id)]

            # Process finished
            return_code = await process.wait()
            if return_code != 0:
                stderr_bytes = await process.stderr.read()
                stderr_text = stderr_bytes.decode('utf-8', errors='ignore').strip()
                embed.title = "<a:cross_animated:1476353024451543040> Solver Error"
                embed.description = f"The solver engine crashed (Exit {return_code}).\n\n**Error:**\n```{sanitize_path(stderr_text)[:500]}```"
                embed.color = COLOR_ERROR
                await msg.edit(embed=embed)
            elif "SESSION COMPLETE" not in line_text: # Ended without completion token
                embed.title = "<a:check:1476352876853858367> Solver Stopped"
                embed.description = "The solver finished unexpectedly without completing the session."
                embed.color = COLOR_INVISIBLE
                await msg.edit(embed=embed)

        except Exception as e:
            try:
                # Catch closed session / expired interaction
                embed = discord.Embed(description=f"<a:cross_animated:1476353024451543040> Error starting solver: {sanitize_path(str(e))}", color=COLOR_ERROR)
                await interaction.followup.send(embed=embed, ephemeral=True)
            except: pass

class AssignmentSelect(discord.ui.Select):
    def __init__(self, user_creds, assignments):
        self.user_creds = user_creds
        self.assignments = assignments
        options = []
        for i, a in enumerate(assignments[:25]):
            options.append(discord.SelectOption(
                label=a['title'][:100], 
                value=str(i), 
                description=f"{a['subject']} | {a['count']}"
            ))
            
        super().__init__(placeholder="Select an assignment to explore...", options=options)

    async def callback(self, interaction: discord.Interaction):
        idx = int(self.values[0])
        assignment_url = self.assignments[idx]['url']
        
        embed = discord.Embed(description=f"<a:LOADING:1476344927947325683> Fetching nuggets for: **{self.assignments[idx]['title']}**...", color=COLOR_INVISIBLE)
        await interaction.response.edit_message(embed=embed, view=None)
        
        data = await run_node_script('scraper.js', [self.user_creds[1], self.user_creds[2], 'nuggets', assignment_url], interaction=interaction)
        
        if data.get('success'):
            nuggets = data.get('nuggets', [])
            if not nuggets:
                embed = discord.Embed(description="<a:cross_animated:1476353024451543040> No nuggets found in this assignment.", color=COLOR_ERROR)
                await interaction.followup.send(embed=embed, ephemeral=True)
                return
            
            embed = discord.Embed(title="🛸 Nuggets Discovered", color=COLOR_PURPLE)
            nugget_list = "\n".join([f"<:purpleasterisk:1476345181174239284> **{n['title']}**" for n in nuggets[:15]])
            if len(nuggets) > 15:
                nugget_list += f"\n*...and {len(nuggets)-15} more*"
            
            is_diagnostic_heavy = any("diagnostic" in n['title'].lower() for n in nuggets)
            mode_type = "Diagnostic-Aware Engine" if is_diagnostic_heavy else "High-Speed Logic Engine"
                
            embed.description = (
                f"Target: **{self.assignments[idx]['title']}**\n\n"
                f"**Payload Statistics:**\n"
                f"📦 Total Nuggets: `{len(nuggets)}` detected\n"
                f"⚡ Speed Profile: `MAX TURBO` enabled\n"
                f"🤖 Mode: `{mode_type}`\n\n"
                f"**Sequence Preview:**\n{nugget_list}"
            )
            
            # Add futuristic GIF
            embed.set_image(url="https://media.discordapp.net/attachments/1476354766199193652/1476354931341393971/standard_3.gif?ex=69a0d22c&is=699f80ac&hm=c5f32699d5f2f20b3567e678e2f0c9637a42ba3bb203573d18fc45465fcc7277&=&width=1200&height=675")
            
            if len(self.user_creds) > 5 and self.user_creds[5]:
                embed.set_footer(text=f"Logged in as {self.user_creds[5]} | Select 'SOLVE ALL' to start sequence")
            
            view = discord.ui.View()
            view.add_item(NuggetSelect(self.user_creds, nuggets))
            await interaction.followup.send(embed=embed, view=view, ephemeral=True)
        else:
            embed = discord.Embed(description=f"<a:cross_animated:1476353024451543040> Error: {sanitize_path(data.get('error'))}", color=COLOR_ERROR)
            await interaction.followup.send(embed=embed, ephemeral=True)

@bot.tree.command(name="solve", description="Browse and solve assignments")
async def solve(interaction: discord.Interaction):
    user = database.get_user(interaction.user.id)
    if not user or not user[4]: # is_locked
        embed = discord.Embed(description="<a:cross_animated:1476353024451543040> You must search and link your account via `/login` first.", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        return

    embed = discord.Embed(description="<a:LOADING:1476344927947325683> Scanning for due assignments...", color=COLOR_INVISIBLE)
    await interaction.response.send_message(embed=embed, ephemeral=True)
    
    data = await run_node_script('scraper.js', [user[1], user[2], 'assignments'], interaction=interaction)
    
    if data.get('success'):
        assignments = data.get('assignments', [])
        if not assignments:
            embed = discord.Embed(description="<a:check:1476352876853858367> No due assignments found! Great job.", color=COLOR_SUCCESS)
            await interaction.edit_original_response(embed=embed)
            return
        
        view = discord.ui.View()
        view.add_item(AssignmentSelect(user, assignments))
        
        embed = discord.Embed(title="🛸 Due Assignments", description=f"Found **{len(assignments)}** assignments.", color=COLOR_PURPLE)
        if len(user) > 5 and user[5]:
            embed.set_footer(text=f"Logged in as {user[5]}")
        await interaction.edit_original_response(embed=embed, view=view)
    else:
        embed = discord.Embed(description=f"<a:cross_animated:1476353024451543040> Error: {sanitize_path(data.get('error'))}", color=COLOR_ERROR)
        await interaction.edit_original_response(embed=embed)

@bot.tree.command(name="test_dm", description="Verify if the bot can send you direct messages")
async def test_dm(interaction: discord.Interaction):
    try:
        embed = discord.Embed(
            title="⚡ Connection Test",
            description="<a:check:1476352876853858367> **DM System Online.**\nNotifications are correctly configured for your account.",
            color=COLOR_SUCCESS
        )
        await interaction.user.send(embed=embed)
        await interaction.response.send_message("<a:check:1476352876853858367> Test message sent! Check your DMs.", ephemeral=True)
    except discord.Forbidden:
        await interaction.response.send_message("<a:cross_animated:1476353024451543040> **DM Failed.** Please enable 'Allow direct messages from server members' in your Privacy Settings.", ephemeral=True)
    except Exception as e:
        await interaction.response.send_message(f"<a:cross_animated:1476353024451543040> **Error:** {str(e)}", ephemeral=True)

if __name__ == "__main__":
    database.init_db()
    if not TOKEN:
        print("ERROR: DISCORD_TOKEN not found in .env")
    else:
        bot.run(TOKEN)
